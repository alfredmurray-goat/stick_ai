#include "repo_archive.hpp"
#include "agent_core.hpp"
#include "inflate.hpp"
#include "json.hpp"
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <set>
#include <stdexcept>
#include <unordered_map>

namespace stellan::repo_archive {
namespace {
constexpr std::uint64_t max_file = 8ull * 1024 * 1024, max_total = 256ull * 1024 * 1024;
constexpr std::size_t max_files = 20000;

struct Sha1 {
    std::array<std::uint32_t, 5> h{0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
    std::uint8_t block[64]{}; std::size_t used = 0; std::uint64_t total = 0;
    static std::uint32_t rol(std::uint32_t v, int n) { return v << n | v >> (32 - n); }
    void compress() {
        std::uint32_t w[80];
        for (int i = 0; i < 16; ++i) { w[i] = std::uint32_t(block[4 * i]) << 24 | std::uint32_t(block[4 * i + 1]) << 16 | std::uint32_t(block[4 * i + 2]) << 8 | block[4 * i + 3]; }
        for (int i = 16; i < 80; ++i) { w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1); }
        auto a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; ++i) {
            std::uint32_t f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; } else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            const auto t = rol(a, 5) + f + e + k + w[i]; e = d; d = c; c = rol(b, 30); b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    void update(std::string_view s) { for (unsigned char ch : s) { block[used++] = ch; ++total; if (used == 64) { compress(); used = 0; } } }
    std::string hex() {
        const auto bits = total * 8; std::string pad(1, '\x80');
        pad.append((used < 56 ? 55 - used : 119 - used), '\0');
        for (int i = 7; i >= 0; --i) { pad += char(bits >> (8 * i)); }
        update(pad);
        static const char *digits = "0123456789abcdef"; std::string out;
        for (auto v : h) { for (int i = 28; i >= 0; i -= 4) { out += digits[(v >> i) & 15]; } }
        return out;
    }
};

// Code points of UTF-8 text (input is valid: JSON strings, or names we decoded ourselves).
std::vector<char32_t> points(std::string_view s) {
    std::vector<char32_t> out;
    for (std::size_t i = 0; i < s.size();) {
        const auto c = static_cast<unsigned char>(s[i]);
        const int n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
        char32_t v = n == 1 ? c : n == 2 ? c & 0x1F : n == 3 ? c & 0x0F : c & 0x07;
        for (int k = 1; k < n && i + k < s.size(); ++k) { v = v << 6 | (static_cast<unsigned char>(s[i + k]) & 0x3F); }
        out.push_back(v); i += n;
    }
    return out;
}
void put(std::string &out, char32_t v) {
    if (v < 0x80) { out += char(v); } else if (v < 0x800) { out += char(0xC0 | v >> 6); out += char(0x80 | (v & 0x3F)); }
    else if (v < 0x10000) { out += char(0xE0 | v >> 12); out += char(0x80 | (v >> 6 & 0x3F)); out += char(0x80 | (v & 0x3F)); }
    else { out += char(0xF0 | v >> 18); out += char(0x80 | (v >> 12 & 0x3F)); out += char(0x80 | (v >> 6 & 0x3F)); out += char(0x80 | (v & 0x3F)); }
}
// toLowerCase for the scripts repository paths realistically use (Latin, Greek, Cyrillic); other letters unchanged.
std::string lower(std::string_view s) {
    std::string out;
    for (char32_t c : points(s)) {
        if ((c >= 'A' && c <= 'Z') || (c >= 0xC0 && c <= 0xDE && c != 0xD7) || (c >= 0x391 && c <= 0x3AB && c != 0x3A2) || (c >= 0x410 && c <= 0x42F)) { c += 32; }
        else if (c >= 0x400 && c <= 0x40F) { c += 80; }
        else if ((c >= 0x100 && c <= 0x137 && c != 0x130) || (c >= 0x14A && c <= 0x177) || (c >= 0x460 && c <= 0x481) || (c >= 0x48A && c <= 0x4BF)) { c |= 1; }
        else if (c == 0x130) { out += "i\xCC\x87"; continue; }
        put(out, c);
    }
    return out;
}
bool safe_part(std::string_view p) {
    if (p.empty()) { return false; }
    const auto l = lower(p);
    if (l == "." || l == ".." || l == ".git" || l == ".stick") { return false; }
    for (unsigned char c : p) { if (c < 0x20 || c == 0x7F || c == '\\' || c == ':' || c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*') { return false; } }
    if (p.back() == '.' || p.back() == ' ') { return false; }
    // /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i: ASCII only, so the ASCII-lowered name decides.
    std::string a; for (char c : p) { a += (c >= 'A' && c <= 'Z') ? char(c + 32) : c; }
    const auto device = [&](std::size_t n) { return a.size() == n || a[n] == '.'; };
    for (const char *d : {"con", "prn", "aux", "nul"}) { if (a.rfind(d, 0) == 0 && device(3)) { return false; } }
    for (const char *d : {"com", "lpt"}) { if (a.rfind(d, 0) == 0 && a.size() >= 4 && a[3] >= '1' && a[3] <= '9' && device(4)) { return false; } }
    return true;
}
bool safe_path(std::string_view path) {
    if (agent::js_length(path) >= 1024) { return false; }
    std::size_t start = 0;
    while (true) {
        const auto slash = path.find('/', start);
        if (!safe_part(path.substr(start, slash == std::string_view::npos ? std::string_view::npos : slash - start))) { return false; }
        if (slash == std::string_view::npos) { return true; }
        start = slash + 1;
    }
}

struct Reader {
    std::string_view z;
    // Bytes past the end read as zero, as fflate's typed-array reads do.
    std::uint32_t byte(std::size_t at) const { return at < z.size() ? static_cast<unsigned char>(z[at]) : 0; }
    std::uint32_t u16(std::size_t at) const { return byte(at) | byte(at + 1) << 8; }
    std::string_view slice(std::size_t from, std::size_t to) const { from = std::min(from, z.size()); to = std::min(std::max(to, from), z.size()); return z.substr(from, to - from); }
    std::uint32_t u32(std::size_t at) const { return u16(at) | u16(at + 2) << 16; }
};
// fflate's strFromU8: UTF-8 when the entry says so (invalid bytes become U+FFFD), otherwise Latin-1.
std::string entry_name(std::string_view raw, bool utf8) {
    std::string out;
    if (!utf8) { for (unsigned char c : raw) { put(out, c); } return out; }
    for (std::size_t i = 0; i < raw.size();) {
        const auto c = static_cast<unsigned char>(raw[i]);
        int n = c < 0x80 ? 1 : (c >= 0xC2 && c < 0xE0) ? 2 : (c >= 0xE0 && c < 0xF0) ? 3 : (c >= 0xF0 && c < 0xF5) ? 4 : 0;
        bool ok = n > 0 && i + n <= raw.size();
        for (int k = 1; ok && k < n; ++k) { ok = (static_cast<unsigned char>(raw[i + k]) & 0xC0) == 0x80; }
        if (ok && n > 1) { const auto v = points(raw.substr(i, n))[0]; ok = !(n == 3 && (v < 0x800 || (v >= 0xD800 && v < 0xE000))) && !(n == 4 && (v < 0x10000 || v > 0x10FFFF)); }
        if (!ok) { out += "\xEF\xBF\xBD"; ++i; continue; }
        out.append(raw.substr(i, n)); i += n;
    }
    return out;
}
}

// UTF-8 to a path on every platform (u8path is deprecated in C++20).
std::filesystem::path utf8_path(std::string_view s) { return std::filesystem::path(std::u8string(s.begin(), s.end())); }

std::string git_blob_sha1(std::string_view bytes) { Sha1 s; s.update("blob " + std::to_string(bytes.size())); s.update(std::string_view("\0", 1)); s.update(bytes); return s.hex(); }

std::vector<std::pair<std::string, std::string>> repository_files(std::string_view archive, const std::vector<TreeEntry> &tree) {
    for (const auto &e : tree) {
        if (e.type == "commit" || (e.type == "blob" && e.mode != "100644" && e.mode != "100755")) { throw GitHubError("This repository contains symlinks or submodules. The current portable workspace supports regular files only."); }
    }
    std::unordered_map<std::string, const TreeEntry *> by_path; std::size_t blobs = 0; bool unsafe = false;
    for (const auto &e : tree) { if (e.type != "blob") { continue; } ++blobs; if (!safe_path(e.path)) { unsafe = true; } by_path[e.path] = &e; }
    if (blobs > max_files || unsafe) { throw GitHubError("This repository contains unsupported paths or too many files."); }
    // The ZIP walk follows fflate's unzipSync: each central entry is checked (the app's filter) and then expanded.
    const Reader r{archive};
    std::size_t eocd = std::string_view::npos;
    for (std::size_t back = 22; back <= archive.size() && back <= 22 + 65535; ++back) { if (r.u32(archive.size() - back) == 0x06054B50) { eocd = archive.size() - back; break; } }
    if (eocd == std::string_view::npos) { throw std::runtime_error("invalid zip data"); }
    const auto count = r.u16(eocd + 8); std::size_t at = r.u32(eocd + 16);
    if (count == 0) { if (blobs) { throw GitHubError("The archive omits tracked files (for example export-ignore). This repository needs a complete regular-file archive."); } return {}; }
    if (r.u32(eocd + 16) == 0xFFFFFFFF || count == 0xFFFF) { throw std::runtime_error("ZIP64 archives are not supported"); }
    std::uint64_t expanded = 0; std::size_t seen_count = 0; std::string prefix; std::set<std::string> seen;
    std::vector<std::pair<std::string, std::string>> files;
    for (std::uint32_t n = 0; n < count; ++n) {
        const auto method = r.u16(at + 10), flags = r.u16(at + 8);
        const std::uint64_t packed = r.u32(at + 20), size = r.u32(at + 24);
        const auto name_length = r.u16(at + 28), extra = r.u16(at + 30), comment = r.u16(at + 32);
        const std::size_t local = r.u32(at + 42);
        const auto name = entry_name(r.slice(at + 46, at + 46 + name_length), flags & 2048);
        at += 46 + name_length + extra + comment;
        expanded += size; ++seen_count;
        if (expanded > max_total || seen_count > max_files * 2 || size > max_file) { throw GitHubError("Repository exceeds workspace limits (8 MB per file, 256 MB expanded)."); }
        const auto slash = name.find('/');
        if (slash == std::string::npos || slash < 1 || name.find('\\') != std::string::npos || name.find('\0') != std::string::npos) { throw GitHubError("Unsafe repository archive path."); }
        const auto top = name.substr(0, slash);
        if (!prefix.empty() && prefix != top) { throw GitHubError("Unexpected repository archive layout."); }
        prefix = top;
        const auto path = name.substr(slash + 1);
        if (path.empty() || path.back() == '/') { if (!path.empty() && !safe_path(std::string_view(path).substr(0, path.size() - 1))) { throw GitHubError("Unsafe archive directory."); } continue; }
        const auto key = lower(path);
        if (!safe_path(path) || !by_path.count(path) || seen.count(key)) { throw GitHubError("Archive does not match the Git source tree or has ambiguous paths."); }
        seen.insert(key);
        const std::size_t data = local + 30 + r.u16(local + 26) + r.u16(local + 28);
        const auto body = r.slice(data, data + packed); // cut short at the end, as fflate's subarray does
        std::string out;
        if (method == 0) { out.assign(body); }
        else if (method == 8 && body.empty()) {} // fflate returns nothing for no input; the hash check decides
        else if (method == 8) {
            inflate::Decoder decoder(true); decoder.set_limit(size);
            try { decoder.feed(reinterpret_cast<const std::uint8_t *>(body.data()), body.size(), [&](const std::uint8_t *b, std::size_t k) { out.append(reinterpret_cast<const char *>(b), k); }); }
            catch (const std::exception &) { if (!decoder.finished()) { throw std::runtime_error("invalid compressed data"); } } // bytes after the end are ignored, as fflate does
            if (!decoder.finished()) { throw std::runtime_error("unexpected EOF"); }
            // Like fflate: data that expands to the wrong bytes is caught by the Git hash check below, not here.
        } else { throw std::runtime_error("unknown compression type"); }
        files.emplace_back(path, std::move(out));
    }
    for (const auto &[path, bytes] : files) {
        if (git_blob_sha1(bytes) != by_path.at(path)->sha) { throw GitHubError("Repository archive differs from its pinned Git commit. LFS archive substitution is not supported."); }
    }
    if (files.size() != blobs) { throw GitHubError("The archive omits tracked files (for example export-ignore). This repository needs a complete regular-file archive."); }
    return files;
}

int main(int argc, char **argv) {
    if (argc != 3) { std::cerr << "usage: stellan-host --repository-files OUTDIR < {archive, tree}\n"; return 2; }
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
    try {
        const std::string input((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
        const auto request = json::parse(input);
        std::vector<TreeEntry> tree;
        for (const auto &e : request.find("tree")->array()) {
            const auto field = [&](const char *k) { const auto *v = e.find(k); return v && v->is_string() ? v->string() : std::string(); };
            tree.push_back({field("path"), field("mode"), field("type"), field("sha")});
        }
        std::ifstream file(utf8_path(request.find("archive")->string()), std::ios::binary);
        if (!file) { throw std::runtime_error("The repository archive could not be read."); }
        const std::string archive((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
        const auto files = repository_files(archive, tree);
        const auto root = utf8_path(argv[2]);
        std::string list = "[";
        for (const auto &[path, bytes] : files) {
            const auto target = root / utf8_path(path);
            std::filesystem::create_directories(target.parent_path());
            std::ofstream out(target, std::ios::binary); out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
            if (!out) { throw std::runtime_error("A repository file could not be written."); }
            if (list.size() > 1) { list += ","; } list += json::stringify_string(path);
        }
        std::cout << "{\"files\":" << list << "]}\n";
    } catch (const GitHubError &error) { std::cout << "{\"error\":" << json::stringify_string(error.what()) << ",\"github\":true}\n"; }
    catch (const std::exception &error) { std::cout << "{\"error\":" << json::stringify_string(error.what()) << ",\"github\":false}\n"; }
    return 0;
}
}
