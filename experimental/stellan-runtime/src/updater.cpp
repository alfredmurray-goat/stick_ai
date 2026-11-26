#include "updater.hpp"

#include "crypto.hpp"
#include "https.hpp"
#include "inflate.hpp"
#include "json.hpp"
#include "runtime.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <random>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <io.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#endif

// A faithful port of src/portable/update.ts, update-format.ts, update-package.ts and update-entry.ts. Every check
// there is kept, in the same order, with the same results on stdout, so the desktop shell can switch between the two.
namespace stellan::updater {
namespace {
namespace fs = std::filesystem;
using json::Value;

// src/portable/update-key.ts
constexpr const char *update_public_key = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA2EtoSAff7C51KTt9hEoRID1kCN60AjUs+eXYkSW13ac=\n-----END PUBLIC KEY-----\n";
constexpr std::array<const char *, 4> targets {"macos-arm64", "macos-x64", "windows-x64", "linux-x64"};
constexpr double max_update_bytes = 512.0 * 1024 * 1024;
const std::set<std::string> locked_model_paths {"models/stellan-1-lite-q4_k_m.locked", "models/stellan-1-lite-q4_k_m-00002-of-00002.gguf", "models/stellan-1.0-q4_k_m.locked", "models/stellan-1.0-q4_k_m-00002-of-00002.gguf"};
const std::string max_model = "models/stellan-1.0-q4_k_m.gguf";
const std::array<const char *, 3> desktop_apps {"Stick AI.app", "Stick AI.exe", "stick-ai"};
std::atomic<bool> cancelled {false};

struct NotFound : std::runtime_error { using std::runtime_error::runtime_error; };
[[noreturn]] void fail(const std::string &message) { throw std::runtime_error(message); }

#ifdef STELLAN_UPDATE_TESTING
// Test builds only (never packaged): a test signing key, and feeds on a local port.
constexpr bool testing = true;
#else
constexpr bool testing = false;
#endif

std::string public_key() {
#ifdef STELLAN_UPDATE_TESTING
    if (const char *key = std::getenv("STELLAN_UPDATE_TEST_KEY")) { return crypto::ed25519_public_key(key); }
#endif
    return crypto::ed25519_public_key(update_public_key);
}

fs::path path_of(const std::string &utf8) { return fs::path(std::u8string(reinterpret_cast<const char8_t *>(utf8.data()), utf8.size())); }
std::string utf8_of(const fs::path &path) { const auto u = path.u8string(); return std::string(reinterpret_cast<const char *>(u.data()), u.size()); }
fs::path join(const fs::path &root, const std::string &relative) { auto p = root / path_of(relative); p.make_preferred(); return p; }

// --- JSON helpers -------------------------------------------------------------------------------------------------
Value str(std::string s) { return Value {std::move(s)}; }
Value num(double d) { return Value {d}; }
Value obj(std::vector<std::pair<std::string, Value>> fields) { auto o = std::make_shared<json::Object>(); for (auto &f : fields) { o->push_back(std::move(f)); } return Value {o}; }
bool is_number(const Value *v) { return v && std::holds_alternative<double>(v->data); }
double number(const Value *v) { return std::get<double>(v->data); }
bool safe_integer(const Value *v) { if (!is_number(v)) { return false; } const auto d = number(v); return std::isfinite(d) && std::floor(d) == d && std::fabs(d) <= 9007199254740991.0; }
bool is_bool(const Value *v) { return v && std::holds_alternative<bool>(v->data); }
// JavaScript truthiness of a JSON value (undefined when the key is missing).
bool js_truthy(const Value *v) {
    if (!v || v->is_null()) { return false; }
    if (is_bool(v)) { return std::get<bool>(v->data); }
    if (std::holds_alternative<double>(v->data)) { const auto d = std::get<double>(v->data); return d != 0 && !std::isnan(d); }
    if (v->is_string()) { return !v->string().empty(); }
    return true;
}
bool truthy_true(const Value *v) { return is_bool(v) && std::get<bool>(v->data); }
const std::string *text(const Value &o, std::string_view key) { const auto *v = o.is_object() ? o.find(key) : nullptr; return v && v->is_string() ? &v->string() : nullptr; }
bool hex(const std::string &s, std::size_t length) { return s.size() == length && std::all_of(s.begin(), s.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }); }
// JSON.stringify(value, null, 2)
void pretty(const Value &v, std::string &out, int indent) {
    const std::string pad(static_cast<std::size_t>(indent + 2), ' '), end(static_cast<std::size_t>(indent), ' ');
    if (v.is_array()) {
        if (v.array().empty()) { out += "[]"; return; }
        out += "[\n";
        for (std::size_t i = 0; i < v.array().size(); ++i) { out += pad; pretty(v.array()[i], out, indent + 2); out += i + 1 < v.array().size() ? ",\n" : "\n"; }
        out += end + "]";
    } else if (v.is_object()) {
        if (v.object().empty()) { out += "{}"; return; }
        out += "{\n";
        for (std::size_t i = 0; i < v.object().size(); ++i) {
            out += pad + json::stringify_string(v.object()[i].first) + ": "; pretty(v.object()[i].second, out, indent + 2);
            out += i + 1 < v.object().size() ? ",\n" : "\n";
        }
        out += end + "}";
    } else { out += json::stringify(v); }
}
std::string pretty(const Value &v) { std::string out; pretty(v, out, 0); return out + "\n"; }
Value with_files(const Value &manifest, json::Array files) {
    auto copy = std::make_shared<json::Object>(manifest.object());
    for (auto &[key, value] : *copy) { if (key == "files") { value = Value {std::make_shared<json::Array>(std::move(files))}; } }
    return Value {copy};
}

// --- Files --------------------------------------------------------------------------------------------------------
std::string read_file(const fs::path &path, std::uintmax_t limit = 64 * 1024 * 1024) {
    std::error_code error;
    const auto size = fs::file_size(path, error);
    if (error) { if (error == std::errc::no_such_file_or_directory) { throw NotFound("Missing file"); } fail("Cannot read a file"); }
    if (size > limit) { fail("File too large"); }
    std::ifstream in(path, std::ios::binary);
    std::string data(static_cast<std::size_t>(size), '\0');
    if (!in.read(data.data(), static_cast<std::streamsize>(data.size()))) { fail("Cannot read a file"); }
    return data;
}
void sync(std::FILE *file) {
    std::fflush(file);
#ifdef _WIN32
    _commit(_fileno(file));
#else
    fsync(fileno(file));
#endif
}
// writeFile(path, data, { flag: "wx" | "w", mode })
void write_file(const fs::path &path, const std::string &data, bool exclusive, bool owner_only = false) {
#ifdef _WIN32
    std::FILE *file = _wfopen(path.c_str(), exclusive ? L"wbx" : L"wb");
#else
    std::FILE *file = std::fopen(path.c_str(), exclusive ? "wbx" : "wb");
#endif
    if (!file) { fail("Cannot write a file"); }
    const bool ok = std::fwrite(data.data(), 1, data.size(), file) == data.size();
    std::fclose(file);
    if (!ok) { fail("Cannot write a file"); }
#ifndef _WIN32
    if (owner_only) { fs::permissions(path, fs::perms::owner_read | fs::perms::owner_write, fs::perm_options::replace); }
#else
    (void)owner_only;
#endif
}
struct Hashed { std::string sha256; std::uintmax_t size; };
Hashed hash_file(const fs::path &path) {
    const auto size = fs::file_size(path);
    if (size == 0) { return {sha256(std::span<const std::byte> {}), 0}; }
    const Mapping mapping(path);
    return {sha256(mapping.bytes()), mapping.bytes().size()};
}
bool present(const fs::path &path) {
    std::error_code error;
    const auto status = fs::symlink_status(path, error);
    if (error && error != std::errc::no_such_file_or_directory) { fail("Cannot read a folder"); }
    return fs::exists(status);
}
// safeDirectory: false when missing; throws when it is anything but a real folder at its own path.
bool safe_directory(const fs::path &path) {
    std::error_code error;
    const auto status = fs::symlink_status(path, error);
    if (error || !fs::exists(status)) { if (!error || error == std::errc::no_such_file_or_directory) { return false; } fail("Unsafe application data directory"); }
    if (!fs::is_directory(status) || fs::is_symlink(status) || fs::canonical(path) != path.lexically_normal()) { fail("Unsafe application data directory"); }
    return true;
}
// integrity.ts staticFiles
void static_files(const fs::path &root, const std::string &prefix, std::vector<std::string> &result) {
    static const std::set<std::string> ignored {".DS_Store", "Thumbs.db", "desktop.ini", ".Spotlight-V100", ".Trashes", ".fseventsd", "System Volume Information", "$RECYCLE.BIN"};
    for (const auto &item : fs::directory_iterator(prefix.empty() ? root : join(root, prefix))) {
        const auto name = utf8_of(item.path().filename());
        if (ignored.count(name) || name.rfind("._", 0) == 0) { continue; }
        const auto path = prefix.empty() ? name : prefix + "/" + name;
        if (path == "logs" || path == "app/project" || path == "manifest.json") { continue; }
        const auto status = item.symlink_status();
        if (fs::is_symlink(status) || (!fs::is_directory(status) && !fs::is_regular_file(status))) { fail("damaged"); }
        if (fs::is_directory(status)) { static_files(root, path, result); } else { result.push_back(path); }
    }
}
std::vector<std::string> static_files(const fs::path &root) { std::vector<std::string> result; static_files(root, "", result); std::sort(result.begin(), result.end()); return result; }

// --- update-format.ts ---------------------------------------------------------------------------------------------
bool update_target(const std::string &t) { return t == "universal" || std::find(targets.begin(), targets.end(), t) != targets.end(); }
std::size_t utf16_length(const std::string &s) { std::size_t n = 0; for (std::size_t i = 0; i < s.size(); ++i) { const auto c = static_cast<unsigned char>(s[i]); if ((c & 0xC0) != 0x80) { n += c >= 0xF0 ? 2 : 1; } } return n; }
std::string ascii_lower(std::string s) { for (auto &c : s) { if (c >= 'A' && c <= 'Z') { c = static_cast<char>(c - 'A' + 'a'); } } return s; }
bool safe_update_path(const Value *value) {
    if (!value || !value->is_string()) { return false; }
    const auto &path = value->string();
    if (path.empty() || utf16_length(path) >= 1024) { return false; }
    for (const unsigned char c : path) { if (c < 0x20 || c == 0x7F || std::string_view("\\:<>\"|?*").find(static_cast<char>(c)) != std::string_view::npos) { return false; } }
    std::size_t start = 0;
    for (;;) {
        const auto slash = path.find('/', start);
        const auto part = path.substr(start, slash == std::string::npos ? std::string::npos : slash - start);
        if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ') { return false; }
        const auto lower = ascii_lower(part);
        const auto stem = lower.substr(0, lower.find('.'));
        if (stem == "con" || stem == "prn" || stem == "aux" || stem == "nul" || (stem.size() == 4 && (stem.rfind("com", 0) == 0 || stem.rfind("lpt", 0) == 0) && stem[3] >= '1' && stem[3] <= '9')) { return false; }
        if (slash == std::string::npos) { return true; }
        start = slash + 1;
    }
}
bool word_repository(const std::string &s) {
    const auto slash = s.find('/');
    if (slash == std::string::npos || slash == 0 || slash + 1 == s.size() || s.find('/', slash + 1) != std::string::npos) { return false; }
    return std::all_of(s.begin(), s.end(), [](char c) { return c == '/' || c == '.' || c == '-' || c == '_' || std::isalnum(static_cast<unsigned char>(c)); });
}
bool valid_feed_url(const Value *value) {
    if (!value || !value->is_string() || utf16_length(value->string()) > 500) { return false; }
    const auto &url = value->string();
    if (url.rfind("https://", 0) != 0) { return false; }
    const auto rest = url.substr(8);
    const auto slash = rest.find('/');
    if (slash == std::string::npos || slash == 0) { return false; }
    const auto authority = rest.substr(0, slash), path = rest.substr(slash);
    if (authority.find('@') != std::string::npos || (!testing && authority.find(':') != std::string::npos)) { return false; }
    if (path.find_first_of("?#\\ ") != std::string::npos) { return false; }
    const std::string suffix = "/stick_ai-updates.json";
    return path.size() >= suffix.size() && path.compare(path.size() - suffix.size(), suffix.size(), suffix) == 0;
}
struct Config { std::string repository, target, source; double sequence = 0; std::optional<std::string> feed; };
Config validate_config(const Value &v) {
    const auto *format = v.is_object() ? v.find("format") : nullptr;
    const auto *repository = text(v, "repository"), *target = text(v, "target"), *source = text(v, "source");
    const auto *sequence = v.is_object() ? v.find("sequence") : nullptr, *feed = v.is_object() ? v.find("feed") : nullptr;
    if (!is_number(format) || number(format) != 1 || !repository || !word_repository(*repository) || !target || !update_target(*target) || !safe_integer(sequence) || number(sequence) < 0 || !source || (feed && !valid_feed_url(feed))) { fail("Invalid update configuration"); }
    Config c {*repository, *target, *source, number(sequence), std::nullopt};
    if (feed) { c.feed = feed->string(); }
    return c;
}
Config read_config(const fs::path &root) {
    const auto path = join(root, "app/update-config.json");
    std::error_code error;
    const auto status = fs::symlink_status(path, error);
    if (!fs::exists(status)) { throw NotFound("Missing update configuration"); }
    if (!fs::is_regular_file(status) || fs::is_symlink(status) || fs::file_size(path) > 10000) { fail("Invalid update configuration"); }
    return validate_config(json::parse(read_file(path)));
}
struct Asset { std::string target, name, sha256; double size = 0; };
struct Feed { std::string repository, source; double sequence = 0; std::vector<Asset> assets; };
Feed verify_feed(const Value &envelope, const std::string &key, const std::string &repository) {
    const auto *payload = text(envelope, "payload"), *signature = text(envelope, "signature");
    if (!payload || !signature || utf16_length(*payload) > 1000000) { fail("Invalid signed update"); }
    const auto bytes = crypto::base64_decode(*payload, false), sig = crypto::base64_decode(*signature, false);
    if (crypto::base64_encode(bytes) != *payload || sig.size() != 64 || key.empty() || !crypto::ed25519_verify(key, bytes, sig)) { fail("Update signature is invalid"); }
    const auto v = json::parse(bytes);
    const auto *format = v.is_object() ? v.find("format") : nullptr, *sequence = v.is_object() ? v.find("sequence") : nullptr, *assets = v.is_object() ? v.find("assets") : nullptr;
    const auto *repo = text(v, "repository"), *source = text(v, "source");
    if (!is_number(format) || number(format) != 1 || !repo || *repo != repository || !safe_integer(sequence) || number(sequence) <= 0 || !source || !hex(*source, 40) || !assets || !assets->is_array() || (assets->array().size() != targets.size() && assets->array().size() != targets.size() + 1)) { fail("Invalid update release"); }
    Feed feed {*repo, *source, number(sequence), {}};
    std::set<std::string> seen;
    for (const auto &item : assets->array()) {
        const auto *target = text(item, "target"), *name = text(item, "name"), *sha = text(item, "sha256");
        const auto *size = item.is_object() ? item.find("size") : nullptr;
        if (!target || !update_target(*target) || seen.count(*target) || !name || *name != "stick_ai-update-" + *target + ".gz" || !sha || !hex(*sha, 64) || !safe_integer(size) || number(size) <= 0 || number(size) > max_update_bytes) { fail("Invalid update release"); }
        seen.insert(*target);
        feed.assets.push_back({*target, *name, *sha, number(size)});
    }
    for (const auto *t : targets) { if (!seen.count(t)) { fail("Invalid update release"); } }
    return feed;
}
bool optional_model(const std::string &path) { return path == max_model || path == "models/stellan-1-lite-q4_k_m.gguf" || locked_model_paths.count(path); }
Value validate_manifest(const Value &m, const std::string &target) {
    const auto *format = m.is_object() ? m.find("format") : nullptr, *list = m.is_object() ? m.find("targets") : nullptr, *files = m.is_object() ? m.find("files") : nullptr;
    bool targets_ok = list && list->is_array();
    if (targets_ok) {
        const auto &t = list->array();
        const auto has = [&](const char *name) { return std::any_of(t.begin(), t.end(), [&](const Value &x) { return x.is_string() && x.string() == name; }); };
        targets_ok = target == "universal" ? t.size() == targets.size() && std::all_of(targets.begin(), targets.end(), has) : t.size() == 1 && t[0].is_string() && t[0].string() == target;
    }
    if (!is_number(format) || number(format) != 1 || !targets_ok || !files || !files->is_array() || files->array().size() > 10000 || !text(m, "nodeRelease") || !text(m, "llamaRelease")) { fail("Update does not match this computer"); }
    std::set<std::string> seen; double size = 0;
    for (const auto &record : files->array()) {
        const auto *path = record.is_object() ? record.find("path") : nullptr;
        const auto *sha = text(record, "sha256"); const auto *bytes = record.is_object() ? record.find("size") : nullptr; const auto *exec = record.is_object() ? record.find("executable") : nullptr;
        if (!safe_update_path(path)) { fail("Unsafe update file"); }
        const auto &p = path->string();
        const bool reserved = p == "logs" || p.rfind("logs/", 0) == 0 || p == "app/project" || p.rfind("app/project/", 0) == 0 || p == ".stick" || p.rfind(".stick/", 0) == 0;
        if (seen.count(ascii_lower(p)) || !sha || !hex(*sha, 64) || !safe_integer(bytes) || number(bytes) < 0 || !is_bool(exec) || p == "manifest.json" || reserved) { fail("Unsafe update file"); }
        if (p.rfind("models/", 0) == 0 && !optional_model(p)) { fail("Unexpected model file"); }
        seen.insert(ascii_lower(p));
        if (p.rfind("models/", 0) != 0) { size += number(bytes); if (number(bytes) > max_update_bytes || size > 2.0 * 1024 * 1024 * 1024) { fail("Update is too large"); } }
    }
    const auto *host_only_value = m.find("hostOnly");
    if (host_only_value && (!truthy_true(host_only_value) || !truthy_true(m.find("nativeHost")))) { fail("Unknown update layout"); }
    const bool host_only = host_only_value != nullptr;
    std::vector<std::string> platforms;
    if (target == "universal") { for (const auto *t : targets) { platforms.emplace_back(t); } } else { platforms.push_back(target); }
    std::vector<std::string> required {"README.txt", "app/update-config.json", "app/ui/index.html", "app/ui/main.js", "app/ui/style.css", "models/stellan-1-lite-q4_k_m.gguf"};
    if (!host_only) { required.emplace_back("app/stick-update.cjs"); required.emplace_back("app/launcher.cjs"); }
    for (const auto &platform : platforms) {
        const bool windows = platform == "windows-x64", mac = platform.rfind("macos-", 0) == 0;
        required.emplace_back(mac ? "Stick AI.app/Contents/MacOS/stick-ai" : windows ? "Stick AI.exe" : "stick-ai");
        required.emplace_back(mac ? "Start.command" : windows ? "Start.bat" : "start.sh");
        if (host_only) { required.push_back("bin/" + platform + "/stellan-host" + (windows ? ".exe" : "")); }
        else { required.push_back("bin/" + platform + "/node" + (windows ? ".exe" : "")); required.push_back("bin/" + platform + "/llama-server" + (windows ? ".exe" : "")); }
    }
    const auto *runtime = m.find("runtime");
    if (runtime && !(runtime->is_string() && runtime->string() == "stellan-run")) { fail("Unknown update runtime"); }
    if (host_only && !runtime) { fail("Unknown update runtime"); }
    if (runtime) {
        if (!host_only) { required.emplace_back("app/stick-engine.cjs"); }
        for (const auto &platform : platforms) { required.push_back("bin/" + platform + "/stellan-run" + (platform == "windows-x64" ? ".exe" : "")); }
    }
    for (const auto &path : required) { if (!seen.count(ascii_lower(path))) { fail("Incomplete update"); } }
    return m;
}
bool same_record(const Value &a, const Value &b) {
    return *text(a, "path") == *text(b, "path") && text(a, "sha256") && text(b, "sha256") && *text(a, "sha256") == *text(b, "sha256") && is_number(a.find("size")) && is_number(b.find("size")) && number(a.find("size")) == number(b.find("size"));
}

// --- Network (update.ts) ------------------------------------------------------------------------------------------
fs::path roots_file;
struct Url { std::string scheme, host, port, path; bool userinfo = false; };
Url parse(const std::string &url) {
    const auto colon = url.find("://");
    if (colon == std::string::npos) { fail("Invalid address"); }
    Url u; u.scheme = url.substr(0, colon);
    const auto rest = url.substr(colon + 3);
    const auto slash = rest.find('/');
    auto authority = rest.substr(0, slash);
    u.path = slash == std::string::npos ? "/" : rest.substr(slash);
    if (authority.find('@') != std::string::npos) { u.userinfo = true; }
    if (const auto c = authority.rfind(':'); c != std::string::npos) { u.port = authority.substr(c + 1); authority = authority.substr(0, c); }
    u.host = ascii_lower(authority);
    return u;
}
std::string resolve(const std::string &base, const std::string &location) {
    if (location.find("://") != std::string::npos) { return location; }
    const auto b = parse(base);
    const auto origin = b.scheme + "://" + b.host + (b.port.empty() ? "" : ":" + b.port);
    if (location.rfind("//", 0) == 0) { return b.scheme + ":" + location; }
    if (!location.empty() && location[0] == '/') { return origin + location; }
    auto directory = b.path.substr(0, b.path.find_first_of("?#"));
    directory = directory.substr(0, directory.rfind('/') + 1);
    return origin + directory + location;
}
const std::string *header(const https::Response &r, const std::string &name) { for (const auto &[n, v] : r.headers) { if (ascii_lower(n) == name) { return &v; } } return nullptr; }
using Sink = std::function<void(const char *, std::size_t)>;
// One request with manual redirects, each hop checked by `allowed` (githubResponse / hostedResponse).
https::Response get(std::string url, const std::function<bool(const Url &)> &allowed, int hops, const std::vector<std::pair<std::string, std::string>> &headers, const std::function<std::vector<std::pair<std::string, std::string>>(const Url &)> &extra, std::size_t max_bytes, const Sink &sink) {
    for (int redirects = 0; redirects <= hops; ++redirects) {
        const auto u = parse(url);
        if (!allowed(u)) { fail("Untrusted update download host"); }
        https::Request request; request.url = url; request.ca_file = utf8_of(roots_file); request.max_bytes = max_bytes; request.timeout_ms = 30000;
        request.headers = headers;
        for (auto &h : extra(u)) { request.headers.push_back(std::move(h)); }
        bool redirect = false;
        const auto response = https::request(request, [&](const char *data, std::size_t size) { if (cancelled) { fail("Update cancelled"); } if (!redirect) { sink(data, size); } },
            [&](const https::Response &r) { redirect = r.status == 301 || r.status == 302 || r.status == 303 || r.status == 307 || r.status == 308; });
        if (!redirect) { return response; }
        const auto *location = header(response, "location");
        if (!location) { fail("Missing update redirect"); }
        url = resolve(url, *location);
    }
    fail("Too many update redirects");
}
bool github_host(const Url &u) {
    static const std::set<std::string> hosts {"api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"};
    return u.scheme == "https" && hosts.count(u.host) && u.port.empty() && !u.userinfo;
}
https::Response github(const std::string &url, const std::string &token, const std::string &accept, std::size_t max, const Sink &sink) {
    return get(url, github_host, 5, {{"Accept", accept}, {"X-GitHub-Api-Version", "2022-11-28"}},
        [&](const Url &u) { std::vector<std::pair<std::string, std::string>> h; if (!token.empty() && u.host == "api.github.com") { h.emplace_back("Authorization", "Bearer " + token); } return h; }, max, sink);
}
https::Response hosted(const std::string &url, std::size_t max, const Sink &sink) {
    const auto origin = parse(url);
    return get(url, [&](const Url &u) { return u.scheme == "https" && u.host == origin.host && u.port == origin.port && !u.userinfo; }, 3, {{"Cache-Control", "no-cache"}},
        [](const Url &) { return std::vector<std::pair<std::string, std::string>> {}; }, max, sink);
}
bool ok(int status) { return status >= 200 && status < 300; }
Value json_response(const std::function<https::Response(const Sink &)> &call) {
    std::string body;
    const auto response = call([&](const char *data, std::size_t size) { body.append(data, size); if (body.size() > 2000000) { fail("Update metadata too large"); } });
    if (!ok(response.status)) { fail(response.status == 401 || response.status == 403 || response.status == 404 ? "UPDATE_AUTH" : "UPDATE_NETWORK"); }
    return json::parse(body);
}
struct Available { Feed feed; Value envelope; Asset asset; std::string url; double id = 0; };
std::optional<Available> find_update(const Config &config, const std::string &token, const std::string &key) {
    if (config.feed) {
        std::string body;
        const auto response = hosted(*config.feed, 2000001, [&](const char *data, std::size_t size) { body.append(data, size); if (body.size() > 2000000) { fail("Update metadata too large"); } });
        if (response.status == 404) { return std::nullopt; }
        if (!ok(response.status)) { fail("UPDATE_NETWORK"); }
        const auto envelope = json::parse(body);
        const auto feed = verify_feed(envelope, key, config.repository);
        if (feed.sequence <= config.sequence || feed.source == config.source) { return std::nullopt; }
        const auto asset = std::find_if(feed.assets.begin(), feed.assets.end(), [&](const Asset &a) { return a.target == config.target; });
        if (asset == feed.assets.end()) { return std::nullopt; }
        // Each build lives in its own folder: <feed folder>/<sequence>/<asset name>.
        const auto url = config.feed->substr(0, config.feed->rfind('/') + 1) + json::stringify(num(feed.sequence)) + "/" + asset->name;
        return Available {feed, envelope, *asset, url, 0};
    }
    const auto api = "https://api.github.com/repos/" + config.repository;
    const auto releases = json_response([&](const Sink &s) { return github(api + "/releases?per_page=20", token, "application/vnd.github+json", 2000001, s); });
    if (!releases.is_array()) { fail("Invalid update releases"); }
    std::optional<Available> latest;
    for (const auto &release : releases.array()) {
        const auto *draft = release.is_object() ? release.find("draft") : nullptr, *assets = release.is_object() ? release.find("assets") : nullptr;
        if (js_truthy(draft) || !assets || !assets->is_array()) { continue; }
        const auto &list = assets->array();
        const auto metadata = std::find_if(list.begin(), list.end(), [](const Value &a) { return text(a, "name") && *text(a, "name") == "stick_ai-updates.json"; });
        if (metadata == list.end() || !safe_integer(metadata->find("id"))) { continue; }
        const auto id = json::stringify(*metadata->find("id"));
        const auto envelope = json_response([&](const Sink &s) { return github(api + "/releases/assets/" + id, token, "application/octet-stream", 2000001, s); });
        const auto feed = verify_feed(envelope, key, config.repository);
        if (feed.sequence <= config.sequence || feed.source == config.source) { continue; }
        const auto selected = std::find_if(feed.assets.begin(), feed.assets.end(), [&](const Asset &a) { return a.target == config.target; });
        if (selected == feed.assets.end()) { continue; }
        const auto download = std::find_if(list.begin(), list.end(), [&](const Value &a) { return text(a, "name") && *text(a, "name") == selected->name && safe_integer(a.find("id")) && is_number(a.find("size")) && number(a.find("size")) == selected->size; });
        if (download == list.end()) { fail("Incomplete app update"); }
        if (!latest || feed.sequence > latest->feed.sequence) { latest = Available {feed, envelope, *selected, "", number(download->find("id"))}; }
    }
    return latest;
}
std::string check(const fs::path &root, const std::string &token) {
    try {
        const auto config = read_config(root);
        const auto update = find_update(config, token, public_key());
        if (update) {
            return json::stringify(obj({{"state", str("available")}, {"sequence", num(update->feed.sequence)}, {"bytes", num(update->asset.size)}, {"message", str("An app update is ready. Your models and projects stay here.")}}));
        }
        return json::stringify(obj({{"state", str("current")}, {"message", str("Your app is up to date.")}}));
    } catch (const NotFound &) {
        return json::stringify(obj({{"state", str("unsupported")}, {"message", str("This copy needs a new platform-specific download once to enable updates.")}}));
    } catch (const std::exception &error) {
        if (testing) { std::cerr << "check: " << error.what() << "\n"; }
        if (std::string(error.what()) == "UPDATE_AUTH") { return json::stringify(obj({{"state", str("authentication")}, {"message", str("GitHub access is needed for private updates. Add a read-only token below.")}})); }
        return json::stringify(obj({{"state", str("offline")}, {"message", str("Updates could not be checked. You can keep using the app offline.")}}));
    }
}

// --- update-package.ts extractUpdateBundle ------------------------------------------------------------------------
void make_executable(const fs::path &path, bool executable) {
#ifndef _WIN32
    using p = fs::perms;
    fs::permissions(path, executable ? p::owner_all | p::group_read | p::group_exec | p::others_read | p::others_exec : p::owner_read | p::owner_write | p::group_read | p::others_read, fs::perm_options::replace);
#else
    (void)path; (void)executable;
#endif
}
Value extract_bundle(const fs::path &bundle, const fs::path &output, const std::string &target) {
    enum class Stage { magic, length, index, files, done } stage = Stage::magic;
    std::string buffer; std::uint32_t length = 0;
    Value manifest; std::vector<const Value *> records; std::size_t current = 0; std::uint64_t remaining = 0;
    std::FILE *file = nullptr; fs::path file_path;
    const auto close_current = [&] {
        sync(file); std::fclose(file); file = nullptr;
        const auto &record = *records[current];
        if (hash_file(file_path).sha256 != *text(record, "sha256")) { fail("Update file checksum failed"); }
        make_executable(file_path, std::get<bool>(record.find("executable")->data));
        ++current;
    };
    const auto open_next = [&] {
        while (current < records.size()) {
            const auto &record = *records[current];
            file_path = join(output, record.find("path")->string());
            fs::create_directories(file_path.parent_path());
#ifdef _WIN32
            file = _wfopen(file_path.c_str(), L"wbx");
#else
            file = std::fopen(file_path.c_str(), "wbx");
            if (file) { fchmod(fileno(file), 0600); }
#endif
            if (!file) { fail("Cannot write the update"); }
            remaining = static_cast<std::uint64_t>(number(record.find("size")));
            if (remaining > 0) { return; }
            close_current();
        }
        stage = Stage::done;
    };
    const auto consume = [&](const std::uint8_t *data, std::size_t size) {
        std::size_t at = 0;
        while (at < size) {
            if (cancelled) { fail("Update cancelled"); }
            if (stage == Stage::magic || stage == Stage::length || stage == Stage::index) {
                const std::size_t want = stage == Stage::magic ? 8 : stage == Stage::length ? 4 : length;
                const auto take = std::min(want - buffer.size(), size - at);
                buffer.append(reinterpret_cast<const char *>(data + at), take); at += take;
                if (buffer.size() < want) { continue; }
                if (stage == Stage::magic) { if (buffer != "STICKUP1") { fail("Invalid update bundle"); } stage = Stage::length; }
                else if (stage == Stage::length) {
                    length = static_cast<std::uint32_t>(static_cast<unsigned char>(buffer[0])) | static_cast<std::uint32_t>(static_cast<unsigned char>(buffer[1])) << 8 | static_cast<std::uint32_t>(static_cast<unsigned char>(buffer[2])) << 16 | static_cast<std::uint32_t>(static_cast<unsigned char>(buffer[3])) << 24;
                    if (length > 4000000) { fail("Update index too large"); }
                    stage = Stage::index;
                } else {
                    manifest = validate_manifest(json::parse(buffer), target);
                    for (const auto &record : manifest.find("files")->array()) { if (record.find("path")->string().rfind("models/", 0) != 0) { records.push_back(&record); } }
                    stage = Stage::files; open_next();
                }
                buffer.clear();
                continue;
            }
            if (stage == Stage::done) { fail("Unlisted update data"); }
            const auto take = static_cast<std::size_t>(std::min<std::uint64_t>(remaining, size - at));
            if (std::fwrite(data + at, 1, take, file) != take) { fail("Cannot write the update"); }
            at += take; remaining -= take;
            if (remaining == 0) { close_current(); open_next(); }
        }
    };
    inflate::Decoder decoder;
    decoder.set_limit(3ULL * 1024 * 1024 * 1024);
    std::ifstream in(bundle, std::ios::binary);
    if (!in) { fail("Cannot read the update"); }
    std::vector<char> chunk(65536);
    try {
        for (;;) {
            in.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
            const auto got = static_cast<std::size_t>(in.gcount());
            if (got == 0) { break; }
            decoder.feed(reinterpret_cast<const std::uint8_t *>(chunk.data()), got, consume);
        }
        if (!decoder.finished() || stage != Stage::done) { fail("Truncated update"); }
    } catch (...) { if (file) { std::fclose(file); } throw; }
    write_file(join(output, "manifest.json"), pretty(manifest), true);
    if (static_files(output).size() != records.size()) { fail("Unexpected update files"); }
    return manifest;
}

// --- update.ts prepare and apply ----------------------------------------------------------------------------------
Value read_manifest(const fs::path &root) { return json::parse(read_file(join(root, "manifest.json"))); }
Value preserve_installed_max(const fs::path &root, const Value &manifest) {
    const auto current = read_manifest(root);
    const auto &files = current.find("files")->array();
    const auto max = std::find_if(files.begin(), files.end(), [](const Value &r) { return text(r, "path") && *text(r, "path") == max_model; });
    const auto &next = manifest.find("files")->array();
    if (max != files.end() && std::none_of(next.begin(), next.end(), [](const Value &r) { return *text(r, "path") == max_model; })) {
        auto list = next; list.push_back(*max);
        return with_files(manifest, std::move(list));
    }
    return manifest;
}
bool optional_true(const Value &record) { return truthy_true(record.find("optional")); }
void compatible_models(const fs::path &root, const Value &manifest) {
    const auto current = read_manifest(root);
    std::vector<const Value *> before, after;
    for (const auto &r : current.find("files")->array()) { if (text(r, "path") && text(r, "path")->rfind("models/", 0) == 0) { before.push_back(&r); } }
    for (const auto &r : manifest.find("files")->array()) { if (text(r, "path")->rfind("models/", 0) == 0) { after.push_back(&r); } }
    const bool kept = std::all_of(before.begin(), before.end(), [&](const Value *old) { return std::any_of(after.begin(), after.end(), [&](const Value *r) { return same_record(*old, *r); }); });
    const bool known = std::all_of(after.begin(), after.end(), [&](const Value *r) {
        return std::any_of(before.begin(), before.end(), [&](const Value *old) { return same_record(*old, *r); }) || (optional_true(*r) && (*text(*r, "path") == max_model || locked_model_paths.count(*text(*r, "path"))));
    });
    if (!kept || !known) { fail("This update requires different models. Keep this version or download a complete package."); }
    if (!safe_directory(join(root, "models")) && !std::all_of(after.begin(), after.end(), [](const Value *r) { return optional_true(*r); })) { fail("The installed models are missing"); }
}
std::string random_suffix() {
    static const char letters[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    std::random_device device; std::string s;
    for (int i = 0; i < 6; ++i) { s += letters[device() % (sizeof letters - 1)]; }
    return s;
}
fs::path make_temporary(const fs::path &parent, const std::string &prefix) {
    for (int attempt = 0; attempt < 100; ++attempt) {
        const auto path = parent / path_of(prefix + random_suffix());
        if (fs::create_directory(path)) {
#ifndef _WIN32
            fs::permissions(path, fs::perms::owner_all, fs::perm_options::replace);
#endif
            return path;
        }
    }
    fail("Cannot prepare the update folder");
}
void download(const Config &config, const Available &update, const std::string &token, const fs::path &path) {
#ifdef _WIN32
    std::FILE *file = _wfopen(path.c_str(), L"wbx");
#else
    std::FILE *file = std::fopen(path.c_str(), "wbx");
    if (file) { fchmod(fileno(file), 0600); }
#endif
    if (!file) { fail("App update download failed"); }
    double size = 0;
    const Sink sink = [&](const char *data, std::size_t n) {
        size += static_cast<double>(n);
        if (size > update.asset.size || size > max_update_bytes) { fail("App update exceeds its signed size"); }
        if (std::fwrite(data, 1, n, file) != n) { fail("App update download failed"); }
    };
    const auto limit = static_cast<std::size_t>(update.asset.size) + 1;
    https::Response response;
    try {
        response = update.url.empty()
            ? github("https://api.github.com/repos/" + config.repository + "/releases/assets/" + json::stringify(num(update.id)), token, "application/octet-stream", limit, sink)
            : hosted(update.url, limit, sink);
        sync(file);
    } catch (...) { std::fclose(file); throw; }
    std::fclose(file);
    if (!ok(response.status)) { fail("App update download failed"); }
    const auto hashed = hash_file(path);
    if (static_cast<double>(hashed.size) != update.asset.size || hashed.sha256 != update.asset.sha256) { fail("App update checksum failed"); }
}
fs::path prepare(const fs::path &root_path, const std::string &token) {
    const auto root = fs::canonical(root_path);
    const auto config = read_config(root);
    const auto key = public_key();
    const auto update = find_update(config, token, key);
    if (!update) { fail("No newer update is available"); }
    const auto work = make_temporary(root.parent_path(), "." + utf8_of(root.filename()) + ".update-");
    try {
        const auto next = work / "next"; fs::create_directory(next);
        download(config, *update, token, work / "download.gz");
        const auto manifest = preserve_installed_max(root, extract_bundle(work / "download.gz", next, config.target));
        write_file(next / "manifest.json", pretty(manifest), false);
        const auto next_config = read_config(next);
        if (next_config.repository != config.repository || next_config.sequence != update->feed.sequence || next_config.source != update->feed.source || next_config.target != config.target) { fail("App update identity mismatch"); }
        compatible_models(root, manifest);
        for (const char *relative : {"app/project", "logs"}) { safe_directory(join(root, relative)); }
        write_file(work / "signed-feed.json", json::stringify(update->envelope), false, true);
        return work;
    } catch (...) { std::error_code ignored; fs::remove_all(work, ignored); throw; }
}
bool executable_bit(const fs::path &path) {
#ifdef _WIN32
    (void)path; return true;
#else
    return (fs::status(path).permissions() & (fs::perms::owner_exec | fs::perms::group_exec | fs::perms::others_exec)) != fs::perms::none;
#endif
}
void verify_tree(const fs::path &root, const Value &manifest, bool models) {
    if (json::stringify(read_manifest(root)) != json::stringify(manifest)) { fail("Changed update manifest"); }
    std::set<std::string> expected;
    for (const auto &record : manifest.find("files")->array()) {
        const auto &relative = record.find("path")->string();
        if (!models && relative.rfind("models/", 0) == 0) { continue; }
        expected.insert(relative);
        const auto path = join(root, relative);
        std::error_code error;
        const auto status = fs::symlink_status(path, error);
        if (!fs::exists(status)) {
            if (optional_true(record) && relative.rfind("models/", 0) == 0 && (!error || error == std::errc::no_such_file_or_directory)) { continue; }
            fail("Unsafe staged update");
        }
        if (!fs::is_regular_file(status) || fs::is_symlink(status) || fs::hard_link_count(path) != 1 || fs::canonical(path) != path.lexically_normal()) { fail("Unsafe staged update"); }
        const auto size = number(record.find("size"));
        // A locked model split is encrypted: its size is checked here, its decrypted hash when it's unlocked.
        if (truthy_true(record.find("locked"))) { if (static_cast<double>(fs::file_size(path)) != size) { fail("Changed staged update"); } continue; }
        const auto hashed = hash_file(path);
        if (static_cast<double>(hashed.size) != size || hashed.sha256 != *text(record, "sha256") || (truthy_true(record.find("executable")) && !executable_bit(path))) { fail("Changed staged update"); }
    }
    for (const auto &file : static_files(root)) { if (!expected.count(file)) { fail("Unlisted staged update file"); } }
}
const char *desktop_entry(const std::string &path) {
    for (const auto *app : desktop_apps) { const std::string a(app); if (path == a || path.rfind(a + "/", 0) == 0) { return app; } }
    return nullptr;
}
bool shared_layout(const fs::path &root) { return root.filename() == "stellan"; }
void apply(const fs::path &root_path, const fs::path &work_path) {
    const auto root = fs::canonical(root_path), work = fs::canonical(work_path);
    const auto prefix = "." + utf8_of(root.filename()) + ".update-";
    if (root.parent_path() != work.parent_path() || utf8_of(work.filename()).rfind(prefix, 0) != 0 || !safe_directory(work)) { fail("Unsafe update staging directory"); }
    const auto lock = root.parent_path() / path_of("." + utf8_of(root.filename()) + ".update-lock");
    if (!fs::create_directory(lock)) { fail("Another update is running"); }
    const auto previous = work / "previous", next = work / "next", old_apps = work / "previous-apps";
    std::vector<std::string> moved, replaced_apps, placed_apps; bool backed_up = false, installed = false;
    const auto parent = root.parent_path();
    try {
        const auto config = read_config(root);
        const auto feed = verify_feed(json::parse(read_file(work / "signed-feed.json")), public_key(), config.repository);
        if (feed.sequence <= config.sequence) { fail("Refusing an older app update"); }
        const auto asset = std::find_if(feed.assets.begin(), feed.assets.end(), [&](const Asset &a) { return a.target == config.target; });
        if (asset == feed.assets.end()) { fail("App update does not match this stick"); }
        const auto bundle = hash_file(work / "download.gz");
        if (bundle.sha256 != asset->sha256 || static_cast<double>(bundle.size) != asset->size) { fail("Changed update download"); }
        const auto inspection = work / "inspection"; fs::create_directory(inspection);
        const auto manifest = preserve_installed_max(root, extract_bundle(work / "download.gz", inspection, config.target));
        fs::remove_all(inspection);
        compatible_models(root, manifest); verify_tree(next, manifest, false);
        const auto next_config = read_config(next);
        if (next_config.sequence != feed.sequence || next_config.source != feed.source || next_config.repository != config.repository || next_config.target != config.target) { fail("App update identity mismatch"); }
        fs::rename(root, previous); backed_up = true;
        for (const char *relative : {"models", "app/project", "logs"}) {
            if (safe_directory(join(previous, relative))) {
                fs::create_directories(join(next, relative).parent_path());
                fs::rename(join(previous, relative), join(next, relative)); moved.emplace_back(relative);
            } else if (std::string(relative) != "models") { fs::create_directories(join(next, relative)); }
        }
        verify_tree(next, manifest, true);
        if (shared_layout(root)) {
            // The apps live beside the stellan folder: swap them in as well, keeping the old ones for rollback.
            std::vector<std::string> apps;
            for (const auto &record : manifest.find("files")->array()) { if (const auto *app = desktop_entry(record.find("path")->string()); app && std::find(apps.begin(), apps.end(), app) == apps.end()) { apps.emplace_back(app); } }
            fs::create_directory(old_apps);
            for (const auto &app : apps) {
                const auto current = parent / path_of(app), incoming = next / path_of(app);
                if (present(current)) { fs::rename(current, old_apps / path_of(app)); replaced_apps.push_back(app); }
                fs::rename(incoming, current); placed_apps.push_back(app);
            }
            json::Array shared;
            for (const auto &record : manifest.find("files")->array()) { if (!desktop_entry(record.find("path")->string())) { shared.push_back(record); } }
            const auto shared_manifest = with_files(manifest, std::move(shared));
            write_file(next / "manifest.json", pretty(shared_manifest), false);
            verify_tree(next, shared_manifest, true);
        }
        fs::rename(next, root); installed = true;
        write_file(work / "rollback.json", json::stringify(obj({{"root", str(utf8_of(root))}, {"previous", str(utf8_of(previous))}, {"installed", num(feed.sequence)}})) + "\n", false);
        fs::remove(work / "download.gz");
    } catch (...) {
        if (backed_up && !installed) {
            for (auto it = placed_apps.rbegin(); it != placed_apps.rend(); ++it) { std::error_code ignored; fs::remove_all(parent / path_of(*it), ignored); }
            for (auto it = replaced_apps.rbegin(); it != replaced_apps.rend(); ++it) { fs::rename(old_apps / path_of(*it), parent / path_of(*it)); }
            for (auto it = moved.rbegin(); it != moved.rend(); ++it) { fs::rename(join(next, *it), join(previous, *it)); }
            fs::rename(previous, root);
        }
        std::error_code ignored; fs::remove_all(lock, ignored);
        throw;
    }
    std::error_code ignored; fs::remove_all(lock, ignored);
}

// --- update-entry.ts ----------------------------------------------------------------------------------------------
bool alive(long long pid) {
#ifdef _WIN32
    HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
    if (!process) { return GetLastError() == ERROR_ACCESS_DENIED; }
    const bool running = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
    CloseHandle(process);
    return running;
#else
    if (kill(static_cast<pid_t>(pid), 0) == 0) { return true; }
    if (errno == ESRCH) { return false; }
    fail("Cannot watch the app");
#endif
}
fs::path own_directory() {
#ifdef _WIN32
    std::wstring buffer(32768, L'\0');
    const auto n = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (n == 0 || n >= buffer.size()) { fail("Invalid updater parent"); }
    buffer.resize(n);
    return fs::path(buffer).parent_path();
#elif defined(__APPLE__)
    std::uint32_t size = 0; _NSGetExecutablePath(nullptr, &size);
    std::string buffer(size, '\0');
    if (_NSGetExecutablePath(buffer.data(), &size) != 0) { fail("Invalid updater parent"); }
    return fs::canonical(fs::path(buffer.c_str())).parent_path();
#else
    return fs::read_symlink("/proc/self/exe").parent_path();
#endif
}
long long parent_argument(const std::string &value) {
    if (value.empty() || value.size() > 15 || !std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; })) { fail("Invalid updater parent"); }
    const auto pid = std::stoll(value);
    if (pid <= 0) { fail("Invalid updater parent"); }
    return pid;
}
void relaunch(const fs::path &root, const fs::path &temporary, bool failed) {
    read_config(root);
    const auto apps = shared_layout(root) ? root.parent_path() : root;
    std::vector<std::string> args {"--cleanup-update", utf8_of(temporary)};
    if (failed) { args.emplace_back("--update-failed"); }
#ifdef STELLAN_UPDATE_TESTING
    if (const char *log = std::getenv("STELLAN_UPDATE_TEST_RELAUNCH")) {
        std::string line = utf8_of(apps); for (const auto &a : args) { line += "\n" + a; }
        write_file(path_of(log), line + "\n", false); return;
    }
#endif
#ifdef _WIN32
    const auto widen = [](const std::string &s) { const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0); std::wstring w(static_cast<std::size_t>(n), L'\0'); MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n); w.resize(static_cast<std::size_t>(n - 1)); return w; };
    // Standard Windows argument quoting, so paths with spaces and quotes reach the app intact.
    const auto quote = [](const std::wstring &arg) {
        std::wstring out = L"\"";
        for (std::size_t i = 0;; ++i) {
            std::size_t slashes = 0;
            while (i < arg.size() && arg[i] == L'\\') { ++slashes; ++i; }
            if (i == arg.size()) { out.append(slashes * 2, L'\\'); break; }
            if (arg[i] == L'"') { out.append(slashes * 2 + 1, L'\\'); out += L'"'; } else { out.append(slashes, L'\\'); out += arg[i]; }
        }
        return out + L"\"";
    };
    const auto program = (apps / L"Stick AI.exe").wstring();
    std::wstring command = quote(program);
    for (const auto &a : args) { command += L" " + quote(widen(a)); }
    STARTUPINFOW startup {}; startup.cb = sizeof startup; PROCESS_INFORMATION process {};
    if (!CreateProcessW(program.c_str(), command.data(), nullptr, nullptr, FALSE, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, nullptr, root.wstring().c_str(), &startup, &process)) { fail("Cannot reopen the app"); }
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
#else
#ifdef __APPLE__
    std::vector<std::string> command {"/usr/bin/open", "-n", "-a", utf8_of(apps / "Stick AI.app"), "--args"};
#else
    std::vector<std::string> command {utf8_of(apps / "stick-ai")};
#endif
    command.insert(command.end(), args.begin(), args.end());
    const auto pid = fork();
    if (pid < 0) { fail("Cannot reopen the app"); }
    if (pid == 0) {
        setsid();
        if (chdir(root.c_str()) != 0) { _exit(127); }
        const int null = open("/dev/null", O_RDWR);
        if (null >= 0) { dup2(null, 0); dup2(null, 1); dup2(null, 2); }
        std::vector<char *> argv; for (auto &a : command) { argv.push_back(a.data()); } argv.push_back(nullptr);
        execv(argv[0], argv.data());
        _exit(127);
    }
#endif
}
std::string argument(int argc, char **argv, const std::string &name) {
    for (int i = 2; i + 1 < argc; ++i) { if (argv[i] == name && std::string(argv[i + 1]).rfind("--", 0) != 0) { return argv[i + 1]; } }
    fail("Missing update argument");
}
bool flag(int argc, char **argv, const std::string &name) { for (int i = 2; i < argc; ++i) { if (argv[i] == name) { return true; } } return false; }
}

int main(int argc, char **argv) {
    try {
        const auto root = fs::absolute(path_of(argument(argc, argv, "--root"))).lexically_normal();
        if (flag(argc, argv, "--apply")) {
            const auto work = fs::absolute(path_of(argument(argc, argv, "--work"))), temporary = fs::absolute(path_of(argument(argc, argv, "--temporary")));
            const auto parent = parent_argument(argument(argc, argv, "--parent"));
            // Runs from its own copy in the temporary folder, because the stick's copy is about to be replaced.
            if (fs::canonical(own_directory()) != fs::canonical(temporary)) { fail("Invalid updater parent"); }
            while (alive(parent)) { std::this_thread::sleep_for(std::chrono::milliseconds(100)); }
            bool failed = false;
            try { apply(root, work); }
            catch (const std::exception &error) {
                if (testing) { std::cerr << "apply: " << error.what() << "\n"; }
                failed = true;
                std::ofstream(work / "update.log", std::ios::app) << "Update could not be applied. The previous version was restored where possible.\n";
            }
            relaunch(root, temporary, failed);
            return 0;
        }
        roots_file = join(root, "app/trusted-roots.pem");
        std::string line;
        if (std::getline(std::cin, line)) {
            if (line.size() > 20000) { fail("Invalid update credentials"); }
            const auto value = json::parse(line);
            line = text(value, "token") ? *text(value, "token") : "";
        }
        const auto token = line;
        if (flag(argc, argv, "--check")) { std::cout << check(root, token) << "\n" << std::flush; return 0; }
        if (flag(argc, argv, "--prepare")) {
            const auto parent = parent_argument(argument(argc, argv, "--parent"));
            std::thread([parent] { while (!cancelled) { std::this_thread::sleep_for(std::chrono::seconds(1)); try { if (!alive(parent)) { cancelled = true; } } catch (...) { cancelled = true; } } }).detach();
            const auto work = prepare(root, token);
            if (cancelled) { std::error_code ignored; fs::remove_all(work, ignored); fail("Update cancelled"); }
            std::cout << json::stringify(obj({{"state", str("prepared")}, {"work", str(utf8_of(work))}})) << "\n" << std::flush;
            return 0;
        }
        fail("Unknown update action");
    } catch (const std::exception &error) {
        if (testing) { std::cerr << "update: " << error.what() << "\n"; }
        std::cout << "{\"state\":\"error\",\"message\":\"The app update could not finish. Your current copy is still available.\"}\n" << std::flush;
        return 1;
    }
}
}
