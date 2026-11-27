#include "identity.hpp"
#include "crypto.hpp"
#include "process.hpp"
#include "runtime.hpp"
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <regex>
#include <span>
#include <vector>

namespace stellan::identity {
namespace fs = std::filesystem;
namespace {
std::vector<std::string> split(std::string_view s, std::string_view by) {
    std::vector<std::string> out; std::size_t start = 0;
    while (true) { const auto at = s.find(by, start); out.emplace_back(s.substr(start, at == std::string_view::npos ? std::string_view::npos : at - start)); if (at == std::string_view::npos) { return out; } start = at + by.size(); }
}
bool space(unsigned char c) { return c == ' ' || (c >= 9 && c <= 13); }
std::string trim(std::string_view s) { std::size_t a = 0, b = s.size(); while (a < b && space(s[a])) { ++a; } while (b > a && space(s[b - 1])) { --b; } return std::string(s.substr(a, b - a)); }
// value.replace(/\s+/g, "").toUpperCase() for the ASCII serials and IDs drives report.
std::string clean(std::string_view s) { std::string out; for (unsigned char c : s) { if (space(c)) { continue; } out += (c >= 'a' && c <= 'z') ? char(c - 32) : char(c); } return out; }
std::string read_text(const fs::path &path) { std::ifstream in(path, std::ios::binary); if (!in) { return ""; } return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()); }
fs::path utf8_path(std::string_view s) { return fs::path(std::u8string(s.begin(), s.end())); }
std::string path_text(const fs::path &p) { const auto u = p.u8string(); return std::string(u.begin(), u.end()); }
std::string real(const fs::path &p) { std::error_code error; const auto r = fs::canonical(p, error); return error ? "" : path_text(r); }
// execFile: the output of a program that exits with 0, or nothing.
std::optional<std::string> exec(std::vector<std::string> argv, int timeout_ms, std::size_t limit = 1024 * 1024) {
    process::Options options; options.argv = std::move(argv); options.timeout_ms = timeout_ms; options.output_limit = limit;
    const auto result = process::run(options);
    if (!result.start_error.empty() || result.stop != process::Result::Stop::none || result.status != 0) { return std::nullopt; }
    return result.out;
}
std::string dirname(const std::string &p) { const auto at = p.find_last_of('/'); return at == std::string::npos ? "." : at == 0 ? "/" : p.substr(0, at); }
std::string basename(const std::string &p) { const auto at = p.find_last_of('/'); return at == std::string::npos ? p : p.substr(at + 1); }

std::string linux_identity(const std::string &path) {
    const auto mount = mount_for(read_text("/proc/self/mountinfo"), path);
    if (!mount || mount->source.rfind("/dev/", 0) != 0) { return ""; }
    auto device = real(mount->source); if (device.empty()) { device = mount->source; }
    // Walk up from the partition in sysfs to the USB device, which has a serial file.
    auto dir = real("/sys/class/block/" + basename(device));
    for (int i = 0; !dir.empty() && i < 12; ++i, dir = dirname(dir)) {
        const auto serial = read_text(dir + "/serial"), vendor = read_text(dir + "/idVendor");
        if (!trim(serial).empty() && !trim(vendor).empty()) { return "usb:" + clean(serial); }
    }
    std::error_code error;
    for (fs::directory_iterator it("/dev/disk/by-uuid", error), end; !error && it != end; it.increment(error)) {
        if (real(it->path()) == device) { return "volume:" + clean(path_text(it->path().filename())); }
    }
    return "";
}
std::string mac_identity(const std::string &path) {
    const auto info = exec({"/usr/sbin/diskutil", "info", path}, 8000);
    if (!info) { return ""; }
    std::smatch m; std::string whole;
    if (std::regex_search(*info, m, std::regex(R"(Part of Whole:\s+(\S+))"))) { whole = m[1]; }
    for (const char *type : {"SPUSBDataType", "SPUSBHostDataType"}) {
        if (whole.empty()) { break; }
        try {
            const auto out = exec({"/usr/sbin/system_profiler", type, "-json"}, 15000, 16 * 1024 * 1024);
            if (!out) { continue; }
            const auto serial = find_serial(json::parse(*out), whole);
            if (!serial.empty()) { return "usb:" + clean(serial); }
        } catch (const std::exception &) {}
    }
    std::string volume;
    if (std::regex_search(*info, m, std::regex(R"(Volume UUID:\s+(\S+))"))) { volume = m[1]; }
    else if (std::regex_search(*info, m, std::regex(R"(Disk / Partition UUID:\s+(\S+))"))) { volume = m[1]; }
    return volume.empty() ? "" : "volume:" + clean(volume);
}
std::string windows_identity(const std::string &path) {
    if (path.size() < 2 || path[1] != ':' || !std::isalpha(static_cast<unsigned char>(path[0]))) { return ""; }
    const char letter = static_cast<char>(std::toupper(static_cast<unsigned char>(path[0])));
    const char *root = std::getenv("SystemRoot"); const std::string system = root ? root : "C:\\Windows";
    if (const auto out = exec({system + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "-NonInteractive", "-Command", std::string("(Get-Partition -DriveLetter ") + letter + " | Get-Disk).SerialNumber"}, 15000)) {
        const auto serial = trim(*out); if (!serial.empty()) { return "usb:" + clean(serial); }
    }
    if (const auto out = exec({system + "\\System32\\cmd.exe", "/d", "/c", std::string("vol ") + letter + ":"}, 8000)) {
        std::smatch m; if (std::regex_search(*out, m, std::regex("([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})"))) { return "volume:" + clean(m[1].str()); }
    }
    return "";
}
std::string hex_sha256(std::string_view text) { return sha256(std::span<const std::byte>(reinterpret_cast<const std::byte *>(text.data()), text.size())); }
}

std::optional<Mount> mount_for(std::string_view mountinfo, std::string_view path) {
    std::optional<Mount> best;
    for (const auto &line : split(mountinfo, "\n")) {
        const auto halves = split(line, " - "); if (halves.size() < 2 || halves[0].empty() || halves[1].empty()) { continue; }
        const auto left = split(halves[0], " "), right = split(halves[1], " ");
        if (left.size() < 5 || right.size() < 2) { continue; }
        std::string mount; const auto &raw = left[4];
        for (std::size_t i = 0; i < raw.size(); ++i) { if (raw.compare(i, 4, "\\040") == 0) { mount += ' '; i += 3; } else { mount += raw[i]; } }
        const auto &source = right[1];
        if (mount.empty() || source.empty()) { continue; }
        const auto prefix = mount.back() == '/' ? mount : mount + "/";
        if (!(path == mount || path.substr(0, prefix.size()) == prefix)) { continue; }
        if (!best || mount.size() > best->mount.size()) { best = Mount{mount, source}; }
    }
    return best;
}

std::string find_serial(const json::Value &tree, std::string_view disk) {
    std::string found;
    std::function<bool(const json::Value &, const std::string &)> walk = [&](const json::Value &node, const std::string &serial) -> bool {
        if (node.is_array()) { for (const auto &item : node.array()) { if (walk(item, serial)) { return true; } } return false; }
        if (!node.is_object()) { return false; }
        const auto *number = node.find("serial_num");
        const auto own = number && number->is_string() && !trim(number->string()).empty() ? number->string() : serial;
        const auto *bsd = node.find("bsd_name");
        if (bsd && bsd->is_string() && bsd->string() == disk && !own.empty()) { found = own; return true; }
        for (const auto &[key, value] : node.object()) { if (walk(value, own)) { return true; } }
        return false;
    };
    walk(tree, "");
    return found;
}

std::string stick_identity(const std::string &root) {
    const auto path = real(utf8_path(root));
    if (path.empty()) { return ""; }
    std::string raw;
    try {
#if defined(__linux__)
        raw = linux_identity(path);
#elif defined(__APPLE__)
        raw = mac_identity(path);
#elif defined(_WIN32)
        raw = windows_identity(path);
#endif
    } catch (const std::exception &) { raw.clear(); }
    return raw.empty() ? "" : hex_sha256("stick-ai:" + raw);
}

namespace {
struct Certificate { std::string code, stick; };
std::optional<Certificate> certificate_for(const std::string &certificate, const std::string &public_key) {
    const auto parts = split(certificate, ".");
    if (parts.size() != 2 || parts[0].empty() || parts[1].empty() || public_key.empty()) { return std::nullopt; }
    try {
        const auto key = crypto::ed25519_public_key(public_key);
        if (key.empty() || !crypto::ed25519_verify(key, parts[0], crypto::base64_decode(parts[1], true))) { return std::nullopt; }
        const auto value = json::parse(crypto::base64_decode(parts[0], true));
        const auto *v = value.find("v"), *code = value.find("code"), *stick = value.find("stick");
        if (!value.is_object() || !v || !std::holds_alternative<double>(v->data) || std::get<double>(v->data) != 1 || !code || !code->is_string() || !stick || !stick->is_string()) { return std::nullopt; }
        return Certificate{code->string(), stick->string()};
    } catch (const std::exception &) { return std::nullopt; }
}
// Activation.check: the saved certificate, checked offline against this stick, and the model keys it unwraps.
std::string activation_check(const std::string &root, const std::string &public_key) {
    if (public_key.empty()) { return R"({"active":true,"keys":{}})"; }
    std::string keys = "{";
    bool active = false;
    try {
        const auto saved = json::parse(read_text(utf8_path(root) / "logs" / "activation.json"));
        const auto *certificate = saved.is_object() ? saved.find("certificate") : nullptr;
        const auto cert = certificate && certificate->is_string() ? certificate_for(certificate->string(), public_key) : std::nullopt;
        const auto id = stick_identity(root);
        active = cert && !id.empty() && cert->stick == id;
        const auto *wrapped = saved.find("keys");
        if (active && wrapped && wrapped->is_object()) {
            for (const char *model : {"stellan-1-lite", "stellan-1-max"}) {
                const auto *w = wrapped->find(model);
                const auto key = w && w->is_string() ? crypto::unwrap_model_key(w->string(), cert->stick, cert->code) : std::nullopt;
                if (key) { if (keys.size() > 1) { keys += ","; } keys += json::stringify_string(model) + ":" + json::stringify_string(crypto::base64_encode(*key)); }
            }
        }
    } catch (const std::exception &) { active = false; keys = "{"; }
    return std::string("{\"active\":") + (active ? "true" : "false") + ",\"keys\":" + keys + "}}";
}
}

int main(int argc, char **argv) {
    const std::string_view mode = argv[1];
    if (mode == "--stick-identity" && argc == 3) { std::cout << "{\"identity\":" << json::stringify_string(stick_identity(argv[2])) << "}\n"; return 0; }
    if (mode == "--activation-check" && argc == 4) { std::cout << activation_check(argv[2], argv[3]) << "\n"; return 0; }
    if (mode == "--identity-check" && argc == 2) {
        // One JSON request per line: {"mountinfo","path"} or {"tree","disk"}; for the tests against activation.ts.
        std::string line;
        while (std::getline(std::cin, line)) {
            const auto request = json::parse(line);
            if (const auto *info = request.find("mountinfo")) {
                const auto m = mount_for(info->string(), request.find("path")->string());
                std::cout << (m ? "{\"mount\":" + json::stringify_string(m->mount) + ",\"source\":" + json::stringify_string(m->source) + "}" : std::string("null")) << "\n";
            } else { std::cout << json::stringify_string(find_serial(*request.find("tree"), request.find("disk")->string())) << "\n"; }
        }
        return 0;
    }
    std::cerr << "usage: stellan-host --stick-identity ROOT | --activation-check ROOT PUBLIC_KEY | --identity-check\n";
    return 2;
}
}
