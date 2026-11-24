#include "workspace.hpp"
#include "host_input.hpp"
#include "runtime.hpp"
#include <algorithm>
#include <cerrno>
#include <memory>
#include <charconv>
#include <cctype>
#include <fstream>
#include <iostream>
#include <optional>
#include <random>
#include <stdexcept>
#include <string_view>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace stellan {
namespace {
constexpr std::size_t file_limit = 1048576;
std::string utf8(const std::filesystem::path &p) { const auto s = p.u8string(); return {reinterpret_cast<const char *>(s.data()), s.size()}; }
std::filesystem::path path(const std::string &s) { return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(s.data()), s.size())); }
void valid_utf8(std::string_view s) {
    for (std::size_t i = 0; i < s.size(); ++i) {
        const auto first = static_cast<unsigned char>(s[i]); if (first < 128) continue;
        const auto count = first >= 0xc2 && first <= 0xdf ? 1U : first >= 0xe0 && first <= 0xef ? 2U : first >= 0xf0 && first <= 0xf4 ? 3U : 0U;
        if (!count || s.size() - i - 1 < count) throw std::runtime_error("Invalid UTF-8");
        unsigned code = first & ((1U << (6 - count)) - 1);
        for (unsigned j = 0; j < count; ++j) { const auto next = static_cast<unsigned char>(s[++i]); if ((next & 0xc0) != 0x80) throw std::runtime_error("Invalid UTF-8"); code = (code << 6) | (next & 63); }
        if (code < (count == 1 ? 128U : count == 2 ? 2048U : 65536U) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw std::runtime_error("Invalid UTF-8");
    }
}
std::string unhex(std::string_view s, std::size_t limit) {
    if (s == "-") return {};
    if (s.size() % 2 || s.size() / 2 > limit) throw std::runtime_error("Invalid or oversized hex payload");
    std::string out; out.reserve(s.size() / 2);
    for (std::size_t i = 0; i < s.size(); i += 2) { unsigned value = 0; const auto r = std::from_chars(s.data() + i, s.data() + i + 2, value, 16); if (r.ec != std::errc() || r.ptr != s.data() + i + 2) throw std::runtime_error("Invalid hex payload"); out += static_cast<char>(value); }
    valid_utf8(out); return out;
}
std::string digest(const std::string &s) { return sha256(std::as_bytes(std::span(s.data(), s.size()))); }
std::string nonce() {
    std::random_device random; std::string out; constexpr char hex[] = "0123456789abcdef";
    for (unsigned i = 0; i < 4; ++i) { auto value = random(); for (unsigned j = 0; j < 8; ++j) { out += hex[value & 15]; value >>= 4; } }
    return out;
}
bool inside(const std::filesystem::path &root, const std::filesystem::path &target) {
    auto a = root.begin(), b = target.begin();
    for (; a != root.end(); ++a, ++b) {
        if (b == target.end()) return false;
        auto left = utf8(*a), right = utf8(*b);
#ifdef _WIN32
        std::transform(left.begin(), left.end(), left.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        std::transform(right.begin(), right.end(), right.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
#endif
        if (left != right) return false;
    }
    return true;
}
void safe_input(const std::string &input) {
    if (input.size() > 4096 || input.find('\0') != std::string::npos || input.starts_with('/') || input.starts_with('\\') || input.find(':') != std::string::npos) throw std::runtime_error("Use project-relative paths without traversal or drive prefixes");
    std::string part;
    const auto check = [&]() {
        if (part == "..") throw std::runtime_error("Path traversal is forbidden");
#ifdef _WIN32
        if (part != "." && !part.empty() && (part.ends_with('.') || part.ends_with(' ') || part.find_first_of("<>\"|?*") != std::string::npos)) throw std::runtime_error("Ambiguous Windows path");
        auto name = part.substr(0, part.find('.')); std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (name == "con" || name == "prn" || name == "aux" || name == "nul" || (name.size() == 4 && (name.starts_with("com") || name.starts_with("lpt")) && name[3] >= '1' && name[3] <= '9')) throw std::runtime_error("Windows device path is forbidden");
#endif
    };
    for (const auto c : input) { if (c == '/' || c == '\\') { check(); part.clear(); } else part += c; } check();
}
struct Handle {
#ifdef _WIN32
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE v = INVALID_HANDLE_VALUE) : value(v) {}
    ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
#else
    int value = -1;
    explicit Handle(int v = -1) : value(v) {}
    ~Handle() { if (value >= 0) close(value); }
#endif
    Handle(const Handle &) = delete; Handle &operator=(const Handle &) = delete;
    Handle(Handle &&other) noexcept : value(other.value) {
#ifdef _WIN32
        other.value = INVALID_HANDLE_VALUE;
#else
        other.value = -1;
#endif
    }
};
class Workspace {
    std::filesystem::path root_;
#ifdef _WIN32
    std::vector<Handle> root_locks_;
    static Handle directory(const std::filesystem::path &p) {
        Handle h(CreateFileW(p.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        BY_HANDLE_FILE_INFORMATION info {};
        if (h.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(h.value, &info) || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Unsafe workspace directory");
        return h;
    }
    std::vector<Handle> lock_parent(const std::filesystem::path &p) const {
        std::vector<Handle> locks; auto current = root_;
        for (const auto &part : p.lexically_relative(root_)) { if (part == ".") continue; if (part == "..") throw std::runtime_error("Path escapes workspace"); current /= part; locks.push_back(directory(current)); }
        return locks;
    }
#else
    Handle root_fd_;
    Handle open_directory(const std::filesystem::path &p, bool create = false) const {
        Handle current(openat(root_fd_.value, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)); if (current.value < 0) throw std::runtime_error("Cannot duplicate workspace root");
        for (const auto &part : p.lexically_relative(root_)) {
            if (part == "." || part.empty()) continue;
            if (part == "..") throw std::runtime_error("Path escapes workspace");
            if (create && mkdirat(current.value, part.c_str(), 0700) != 0 && errno != EEXIST) throw std::runtime_error("Cannot create workspace directory");
            Handle next(openat(current.value, part.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
            if (next.value < 0) { if (!create && errno == ENOENT) return Handle(); throw std::runtime_error("Unsafe workspace directory"); }
            std::swap(current.value, next.value);
        }
        return current;
    }
#endif
public:
    explicit Workspace(const std::filesystem::path &root) : root_(std::filesystem::canonical(root)) {
        if (!std::filesystem::is_directory(root_)) throw std::runtime_error("Workspace root must be a directory");
#ifdef _WIN32
        auto current = root_.root_path(); root_locks_.push_back(directory(current));
        for (const auto &part : root_.relative_path()) { current /= part; root_locks_.push_back(directory(current)); }
#else
        root_fd_.value = open(root_.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (root_fd_.value < 0) throw std::runtime_error("Cannot open workspace root");
#endif
    }
    Handle own_state_store() const {
#ifdef _WIN32
        Handle h(CreateFileW((root_ / L".owner.lock").c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        BY_HANDLE_FILE_INFORMATION info {};
        if (h.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(h.value, &info) || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || info.nNumberOfLinks != 1) throw std::runtime_error("State store is unsafe or already owned");
#else
        Handle h(openat(root_fd_.value, ".owner.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600));
        struct stat info {};
        if (h.value < 0 || fstat(h.value, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 || flock(h.value, LOCK_EX | LOCK_NB) != 0) throw std::runtime_error("State store is unsafe or already owned");
#endif
        return h;
    }
    std::filesystem::path resolve(const std::string &input) const {
        safe_input(input); std::string normalized = input; std::replace(normalized.begin(), normalized.end(), '\\', '/');
        const auto target = std::filesystem::weakly_canonical(root_ / path(normalized));
        if (!inside(root_, target)) throw std::runtime_error("Path resolves outside workspace");
        const auto relative = target.lexically_relative(root_);
        if (!relative.empty()) { auto first = utf8(*relative.begin()); std::transform(first.begin(), first.end(), first.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); }); if (first == ".stick") throw std::runtime_error(".stick is reserved for session state"); }
        return target;
    }
    std::optional<std::string> read(const std::filesystem::path &p) const {
        std::string out;
#ifdef _WIN32
        if (!std::filesystem::exists(p.parent_path())) return std::nullopt;
        auto locks = lock_parent(p.parent_path());
        Handle h(CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (h.value == INVALID_HANDLE_VALUE) { if (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND) return std::nullopt; throw std::runtime_error("Cannot read workspace file"); }
        BY_HANDLE_FILE_INFORMATION info {};
        if (!GetFileInformationByHandle(h.value, &info) || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || info.nNumberOfLinks != 1 || info.nFileSizeHigh != 0 || info.nFileSizeLow > file_limit) throw std::runtime_error("Read requires a regular file under 1 MiB without hard links");
        std::array<char, 8192> bytes; DWORD n = 0;
        while (true) { if (!ReadFile(h.value, bytes.data(), static_cast<DWORD>(bytes.size()), &n, nullptr)) throw std::runtime_error("Cannot read workspace file"); if (!n) break; if (out.size() + n > file_limit) throw std::runtime_error("File grew beyond 1 MiB"); out.append(bytes.data(), n); }
#else
        auto parent = open_directory(p.parent_path());
        if (parent.value < 0) return std::nullopt;
        Handle h(openat(parent.value, p.filename().c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
        if (h.value < 0) { if (errno == ENOENT) return std::nullopt; throw std::runtime_error("Cannot read workspace file"); }
        struct stat info {};
        if (fstat(h.value, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 || info.st_size < 0 || static_cast<std::uint64_t>(info.st_size) > file_limit) throw std::runtime_error("Read requires a regular file under 1 MiB without hard links");
        std::array<char, 8192> bytes;
        while (true) { const auto n = ::read(h.value, bytes.data(), bytes.size()); if (n < 0) { if (errno == EINTR) continue; throw std::runtime_error("Cannot read workspace file"); } if (!n) break; if (out.size() + static_cast<std::size_t>(n) > file_limit) throw std::runtime_error("File grew beyond 1 MiB"); out.append(bytes.data(), static_cast<std::size_t>(n)); }
#endif
        valid_utf8(out); return out;
    }
    struct Item { std::string name; bool directory, symlink; };
    std::vector<Item> children(const std::filesystem::path &p) const {
        std::vector<Item> entries;
#ifdef _WIN32
        auto locks = lock_parent(p);
        for (const auto &entry : std::filesystem::directory_iterator(p)) {
            if (entries.size() >= 10000) throw std::runtime_error("Directory exceeds 10000 entries");
            const auto name = utf8(entry.path().filename()); valid_utf8(name);
            const auto info = entry.symlink_status();
            entries.push_back({name, std::filesystem::is_directory(info), std::filesystem::is_symlink(info)});
        }
#else
        auto lock = open_directory(p);
        if (lock.value < 0) throw std::runtime_error("Directory not found");
        auto *stream = fdopendir(dup(lock.value));
        if (!stream) throw std::runtime_error("Cannot list directory");
        struct DirectoryCloser { void operator()(DIR *d) const { closedir(d); } };
        std::unique_ptr<DIR, DirectoryCloser> directory_stream(stream);
        while (true) {
            errno = 0; const auto *entry = readdir(stream);
            if (!entry) { if (errno) throw std::runtime_error("Cannot list directory"); break; }
            const std::string name(entry->d_name);
            if (name == "." || name == "..") continue;
            if (entries.size() >= 10000) throw std::runtime_error("Directory exceeds 10000 entries");
            valid_utf8(name); struct stat info {};
            if (fstatat(lock.value, name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0) throw std::runtime_error("Directory changed during listing");
            entries.push_back({name, S_ISDIR(info.st_mode), S_ISLNK(info.st_mode)});
        }
#endif
        std::sort(entries.begin(), entries.end(), [](const Item &a, const Item &b) { return a.name < b.name; });
        return entries;
    }
    std::string list(const std::filesystem::path &p) const {
        std::string result;
        for (const auto &entry : children(p)) {
            auto name = entry.name; auto folded = name;
            std::transform(folded.begin(), folded.end(), folded.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (folded == ".stick") continue;
            name += entry.symlink ? " [symlink]" : entry.directory ? "/" : "";
            if (result.size() + name.size() + 1 > 32768) break;
            if (!result.empty()) result += '\n';
            result += name;
        }
        return result;
    }
    std::string search(const std::string &query, const std::function<bool()> &cancelled) const {
        if (query.empty()) throw std::runtime_error("Empty search query");
        std::vector<std::filesystem::path> pending {root_}; std::size_t visited = 0, matches = 0; std::string result;
        while (!pending.empty() && visited < 10000 && matches < 200) {
            const auto directory = pending.back(); pending.pop_back();
            for (const auto &entry : children(directory)) {
                if (cancelled()) throw std::runtime_error("Search cancelled");
                if (++visited > 10000 || matches >= 200) break;
                auto folded = entry.name;
                std::transform(folded.begin(), folded.end(), folded.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                if (folded == ".stick" || folded == ".git" || folded == "node_modules" || entry.symlink) continue;
                const auto child = directory / path(entry.name);
                if (utf8(child.lexically_relative(root_)).size() > 4096) continue;
                if (entry.directory) { pending.push_back(child); continue; }
                std::optional<std::string> content;
                try { content = read(child); } catch (...) { continue; }
                if (!content) continue;
                std::size_t first = 0, number = 1;
                while (first <= content->size() && matches < 200) {
                    const auto end = content->find('\n', first);
                    auto line = std::string_view(*content).substr(first, end == std::string::npos ? end : end - first);
                    if (line.find(query) != std::string::npos) {
                        auto length = std::min<std::size_t>(line.size(), 300);
                        while (length < line.size() && length && (static_cast<unsigned char>(line[length]) & 0xc0) == 0x80) --length;
                        auto relative_name = utf8(child.lexically_relative(root_));
                        std::replace(relative_name.begin(), relative_name.end(), '\\', '/');
                        const auto match = relative_name + ":" + std::to_string(number) + ":" + std::string(line.substr(0, length));
                        if (result.size() + match.size() + 1 > 32768) return result;
                        if (!result.empty()) result += '\n';
                        result += match; ++matches;
                    }
                    if (end == std::string::npos) break;
                    first = end + 1; ++number;
                }
            }
        }
        return result.empty() ? "No matches" : result;
    }
    void write(const std::filesystem::path &p, const std::string &content, const std::function<bool()> &cancelled) const {
        const auto temporary = ".stick-" + nonce() + ".tmp";
#ifdef _WIN32
        // Lock every existing parent before creating children; directory handles deny rename/reparse replacement.
        auto parent = root_; std::vector<Handle> locks;
        for (const auto &part : p.parent_path().lexically_relative(root_)) { if (part == ".") continue; if (part == "..") throw std::runtime_error("Path escapes workspace"); parent /= part; if (!CreateDirectoryW(parent.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) throw std::runtime_error("Cannot create workspace directory"); locks.push_back(directory(parent)); }
        const auto temp = parent / path(temporary);
        try {
            { Handle h(CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); if (h.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create workspace temporary file"); DWORD written = 0; if (!WriteFile(h.value, content.data(), static_cast<DWORD>(content.size()), &written, nullptr) || static_cast<std::size_t>(written) != content.size() || !FlushFileBuffers(h.value)) throw std::runtime_error("Cannot save workspace file"); }
            if (cancelled()) throw std::runtime_error("Cancelled before commit");
            if (!MoveFileExW(temp.c_str(), p.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("Cannot replace workspace file");
        } catch (...) { DeleteFileW(temp.c_str()); throw; }
#else
        auto parent = open_directory(p.parent_path(), true);
        struct stat old_info {}; const bool existed = fstatat(parent.value, p.filename().c_str(), &old_info, AT_SYMLINK_NOFOLLOW) == 0;
        if (existed && (!S_ISREG(old_info.st_mode) || old_info.st_nlink != 1)) throw std::runtime_error("Unsafe write target");
        try {
            { Handle h(openat(parent.value, temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600)); if (h.value < 0) throw std::runtime_error("Cannot create workspace temporary file"); std::size_t offset = 0; while (offset < content.size()) { const auto n = ::write(h.value, content.data() + offset, content.size() - offset); if (n < 0) { if (errno == EINTR) continue; throw std::runtime_error("Cannot write workspace file"); } if (!n) throw std::runtime_error("Cannot write workspace file"); offset += static_cast<std::size_t>(n); } if (existed && fchmod(h.value, old_info.st_mode & 0777) != 0) throw std::runtime_error("Cannot preserve permissions"); if (fsync(h.value) != 0) throw std::runtime_error("Cannot sync workspace file"); }
            if (cancelled()) throw std::runtime_error("Cancelled before commit");
            if (renameat(parent.value, temporary.c_str(), parent.value, p.filename().c_str()) != 0) throw std::runtime_error("Cannot replace workspace file");
        } catch (...) { unlinkat(parent.value, temporary.c_str(), 0); throw; }
#endif
    }
};
struct Proposal { std::string id, input, content; std::filesystem::path target; std::optional<std::string> before; };
}
int workspace_service(const std::filesystem::path &root, const std::function<bool()> &cancelled) {
    Workspace box(root); HostInput input; std::optional<Proposal> pending;
    std::cout << "{\"event\":\"ready\",\"protocol\":1,\"scope\":\"workspace-files\",\"node_required\":false,\"writes_require_approval\":true}\n" << std::flush;
    std::string line;
    while (!cancelled() && input.read_line(line, cancelled)) {
        unsigned id = 0;
        try {
            if (line == "shutdown") { std::cout << "{\"event\":\"stopped\"}\n" << std::flush; break; }
            const auto first = line.find(' '), second = first == std::string::npos ? first : line.find(' ', first + 1);
            if (first == std::string::npos || second == std::string::npos) throw std::runtime_error("Expected request ID, operation and hex arguments");
            const auto number = std::from_chars(line.data(), line.data() + first, id); if (number.ec != std::errc() || number.ptr != line.data() + first || !id) throw std::runtime_error("Invalid request ID");
            const auto operation = line.substr(first + 1, second - first - 1); const auto args = std::string_view(line).substr(second + 1);
            std::string result;
            if (operation == "approve" || operation == "deny") {
                if (!pending || args != pending->id) throw std::runtime_error("No matching pending approval");
                auto proposal = std::move(*pending); pending.reset();
                if (operation == "deny") result = "Denied by user";
                else {
                    if (box.resolve(proposal.input) != proposal.target || box.read(proposal.target) != proposal.before) throw std::runtime_error("File changed while waiting for approval; review a new proposal");
                    if (cancelled()) throw std::runtime_error("Cancelled before write");
                    box.write(proposal.target, proposal.content, cancelled); result = "Wrote " + std::to_string(proposal.content.size()) + " bytes to " + proposal.input;
                }
            } else if (operation == "search_files") {
                result = box.search(unhex(args, 4096), cancelled);
            } else if (operation == "read_file" || operation == "list_dir") {
                const auto target = box.resolve(unhex(args, 4096));
                if (operation == "list_dir") result = box.list(target);
                else { const auto content = box.read(target); if (!content) throw std::runtime_error("File not found"); result = *content; }
            } else if (operation == "write_file" || operation == "edit_file") {
                if (pending) throw std::runtime_error("Review or deny the pending change first");
                const auto separator = args.find(' '); if (separator == std::string_view::npos) throw std::runtime_error("Expected path and content");
                const auto name = unhex(args.substr(0, separator), 4096); const auto target = box.resolve(name); const auto before = box.read(target);
                std::string content;
                if (operation == "write_file") content = unhex(args.substr(separator + 1), file_limit);
                if (operation == "edit_file") {
                    const auto replacement = args.find(' ', separator + 1); if (replacement == std::string_view::npos || !before) throw std::runtime_error("Expected an existing file, old text and replacement");
                    const auto old = unhex(args.substr(separator + 1, replacement - separator - 1), file_limit); const auto next = unhex(args.substr(replacement + 1), file_limit);
                    const auto found = before->find(old); if (old.empty() || found == std::string::npos || before->find(old, found + 1) != std::string::npos) throw std::runtime_error("edit_file requires exactly one nonempty match");
                    content = *before; content.replace(found, old.size(), next);
                }
                if (content.size() > file_limit) throw std::runtime_error("Write exceeds 1 MiB");
                pending = Proposal {nonce(), name, std::move(content), target, before};
                std::cout << "{\"event\":\"approval_required\",\"request_id\":" << id << ",\"approval_id\":" << json_string(pending->id) << ",\"path\":" << json_string(name) << ",\"operation\":" << json_string(operation) << ",\"bytes\":" << pending->content.size() << ",\"after_sha256\":" << json_string(digest(pending->content)) << "}\n" << std::flush; continue;
            } else throw std::runtime_error("Unsupported workspace operation");
            std::cout << "{\"event\":\"result\",\"request_id\":" << id << ",\"text\":" << json_string(result) << "}\n" << std::flush;
        } catch (const std::exception &error) { std::cout << "{\"event\":\"error\",\"request_id\":" << id << ",\"message\":" << json_string(error.what()) << "}\n" << std::flush; }
    }
    return cancelled() ? 130 : 0;
}
int state_store_service(const std::filesystem::path &root, const std::function<bool()> &cancelled) {
    Workspace box(root); auto ownership = box.own_state_store(); (void)ownership;
    HostInput input;
    std::cout << "{\"event\":\"ready\",\"protocol\":1,\"scope\":\"session-state\",\"node_required\":false,\"max_record_bytes\":65536}\n" << std::flush;
    const auto valid_id = [](std::string_view id) {
        if (id.size() != 36) return false;
        for (std::size_t i = 0; i < id.size(); ++i) {
            if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return false; }
            else if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return false;
        }
        return true;
    };
    std::string line;
    while (!cancelled() && input.read_line(line, cancelled)) {
        unsigned id = 0;
        try {
            if (line == "shutdown") { std::cout << "{\"event\":\"stopped\"}\n" << std::flush; break; }
            const auto first = line.find(' '), second = first == std::string::npos ? first : line.find(' ', first + 1);
            if (first == std::string::npos || second == std::string::npos) throw std::runtime_error("Expected ID, operation and record ID");
            const auto parsed = std::from_chars(line.data(), line.data() + first, id);
            if (!id || parsed.ec != std::errc() || parsed.ptr != line.data() + first) throw std::runtime_error("Invalid request ID");
            const auto operation = line.substr(first + 1, second - first - 1);
            const auto args = std::string_view(line).substr(second + 1); const auto space = args.find(' ');
            const auto key = args.substr(0, space);
            if (!valid_id(key)) throw std::runtime_error("State record ID must be a lowercase UUID");
            if (operation != "state_get" && operation != "state_put") throw std::runtime_error("Unsupported state operation");
            const auto target = box.resolve(std::string(key) + ".txt"); auto before = box.read(target);
            if (before && before->size() > 65536) throw std::runtime_error("State record exceeds 64 KiB");
            const auto revision = before ? digest(*before) : "missing";
            if (operation == "state_get") {
                if (space != std::string_view::npos) throw std::runtime_error("Unexpected state_get arguments");
                std::cout << "{\"event\":\"state\",\"request_id\":" << id << ",\"exists\":" << (before ? "true" : "false") << ",\"revision\":" << json_string(revision) << ",\"text\":" << json_string(before.value_or("")) << "}\n" << std::flush;
            } else {
                if (space == std::string_view::npos) throw std::runtime_error("Expected revision and hex text");
                const auto next = args.find(' ', space + 1);
                if (next == std::string_view::npos) throw std::runtime_error("Expected revision and hex text");
                if (args.substr(space + 1, next - space - 1) != revision) throw std::runtime_error("State revision conflict; read and reconcile before saving");
                const auto content = unhex(args.substr(next + 1), 65536);
                if (cancelled()) throw std::runtime_error("Cancelled before state save");
                box.write(target, content, cancelled);
                std::cout << "{\"event\":\"saved\",\"request_id\":" << id << ",\"revision\":" << json_string(digest(content)) << ",\"bytes\":" << content.size() << "}\n" << std::flush;
            }
        } catch (const std::exception &error) {
            std::cout << "{\"event\":\"error\",\"request_id\":" << id << ",\"message\":" << json_string(error.what()) << "}\n" << std::flush;
        }
    }
    return cancelled() ? 130 : 0;
}

}
