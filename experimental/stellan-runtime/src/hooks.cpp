#include "hooks.hpp"

#include "agent_core.hpp"
#include "https.hpp"
#include "json.hpp"
#include "process.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <functional>
#include <optional>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <regex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

// Hooks from src/portable/hooks.ts in Host: checking a hook's settings (hookConfig), running one hook and reading its
// reply (readReply). Hooks may block or add notes; they never approve anything, and they are only ever read from the
// app's own settings.
namespace stellan::hooks {
namespace {
using json::Value;
struct HookError : std::runtime_error { using std::runtime_error::runtime_error; };
[[noreturn]] void fail(const std::string &message) { throw HookError(message); }
const std::vector<std::string> events {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"};
bool tool_event(const std::string &e) { return e == "PreToolUse" || e == "PostToolUse"; }
bool blocking(const std::string &e) { return e == "UserPromptSubmit" || tool_event(e); }
constexpr std::size_t output_limit = 65536;

Value str(std::string s) { return Value {std::move(s)}; }
Value num(double d) { return Value {d}; }
Value obj(std::vector<std::pair<std::string, Value>> fields) { auto o = std::make_shared<json::Object>(); for (auto &f : fields) { o->push_back(std::move(f)); } return Value {o}; }
const std::string *text(const Value &o, std::string_view k) { const auto *v = o.is_object() ? o.find(k) : nullptr; return v && v->is_string() ? &v->string() : nullptr; }
std::string lower(std::string s) { for (auto &c : s) { if (c >= 'A' && c <= 'Z') { c = static_cast<char>(c - 'A' + 'a'); } } return s; }
std::size_t utf16_length(const std::string &s) { std::size_t n = 0; for (const unsigned char c : s) { if ((c & 0xC0) != 0x80) { n += c >= 0xF0 ? 2 : 1; } } return n; }

struct Url { std::string scheme, host, port, path, href; bool credentials = false, fragment = false; };
// The WHATWG URL fields hookConfig looks at, for the absolute http(s) addresses hooks use.
Url parse_url(const std::string &raw) {
    const auto input = agent::js_trim(raw);
    const auto colon = input.find("://");
    if (colon == std::string::npos) { throw std::runtime_error("Invalid URL"); }
    Url u; u.scheme = lower(input.substr(0, colon)) + ":";
    auto rest = input.substr(colon + 3);
    const auto hash = rest.find('#'); if (hash != std::string::npos) { u.fragment = hash + 1 < rest.size(); rest = rest.substr(0, hash); }
    const auto slash = rest.find_first_of("/?");
    auto authority = rest.substr(0, slash);
    u.path = slash == std::string::npos ? "/" : rest.substr(slash);
    if (!u.path.empty() && u.path[0] == '?') { u.path = "/" + u.path; }
    if (const auto at = authority.rfind('@'); at != std::string::npos) { u.credentials = at > 0; authority = authority.substr(at + 1); }
    if (authority.empty()) { throw std::runtime_error("Invalid URL"); }
    if (authority[0] == '[') { const auto close = authority.find(']'); if (close == std::string::npos) { throw std::runtime_error("Invalid URL"); } u.host = lower(authority.substr(0, close + 1)); if (close + 1 < authority.size()) { if (authority[close + 1] != ':') { throw std::runtime_error("Invalid URL"); } u.port = authority.substr(close + 2); } }
    else { const auto c = authority.rfind(':'); u.host = lower(authority.substr(0, c)); if (c != std::string::npos) { u.port = authority.substr(c + 1); } }
    for (const char c : u.port) { if (c < '0' || c > '9') { throw std::runtime_error("Invalid URL"); } }
    if (!u.port.empty() && std::stoul(u.port) > 65535) { throw std::runtime_error("Invalid URL"); }
    if ((u.scheme == "http:" && u.port == "80") || (u.scheme == "https:" && u.port == "443")) { u.port.clear(); }
    if (u.host.empty() || u.host.find_first_of(" <>^`{|}\\") != std::string::npos) { throw std::runtime_error("Invalid URL"); }
    u.href = u.scheme + "//" + u.host + (u.port.empty() ? "" : ":" + u.port) + u.path;
    return u;
}
bool loopback(const std::string &host) { return host == "127.0.0.1" || host == "localhost" || host == "[::1]"; }

Value config(const Value &input, const std::string &id) {
    if (!input.is_object()) { fail("Enter the hook's settings."); }
    const auto *event = text(input, "event");
    if (!event || std::find(events.begin(), events.end(), *event) == events.end()) { fail("Choose when the hook runs."); }
    const auto *name_value = text(input, "name");
    const auto name = name_value && !agent::js_trim(*name_value).empty() ? agent::js_trim(*name_value) : *event;
    if (utf16_length(name) > 80 || std::any_of(name.begin(), name.end(), [](char c) { return static_cast<unsigned char>(c) < 0x20; })) { fail("Use a hook name under 80 characters."); }
    const auto matcher = text(input, "matcher") ? agent::js_trim(*text(input, "matcher")) : std::string();
    if (!matcher.empty() && !tool_event(*event)) { fail("Only tool hooks (before or after a tool) use a tool filter. Leave it empty."); }
    if (utf16_length(matcher) > 200) { fail("Keep the tool filter under 200 characters."); }
    if (!matcher.empty() && matcher != "*") { try { std::regex("^(?:" + matcher + ")$", std::regex::ECMAScript); } catch (const std::exception &) { fail("The tool filter isn't valid. Use a tool name such as edit_file, or write_file|edit_file."); } }
    // timeout: undefined or "" means 30; otherwise Number(value) must be a whole number from 1 to 600.
    double timeout = 30;
    if (const auto *t = input.find("timeout"); t && !(t->is_string() && t->string().empty())) {
        if (std::holds_alternative<double>(t->data)) { timeout = std::get<double>(t->data); }
        else if (t->is_string()) { const auto s = agent::js_trim(t->string()); char *end = nullptr; timeout = s.empty() ? 0 : std::strtod(s.c_str(), &end); if (!s.empty() && *end) { timeout = NAN; } }
        else if (std::holds_alternative<bool>(t->data)) { timeout = std::get<bool>(t->data) ? 1 : 0; }
        else if (t->is_null()) { timeout = 0; }
        else { timeout = NAN; }
    }
    if (!(std::floor(timeout) == timeout) || timeout < 1 || timeout > 600) { fail("Set a time limit between 1 and 600 seconds."); }
    const auto *enabled_value = input.find("enabled");
    const bool enabled = !(enabled_value && std::holds_alternative<bool>(enabled_value->data) && !std::get<bool>(enabled_value->data));
    const auto *type = text(input, "type");
    if (type && *type == "http") {
        Url url;
        try {
            const auto *u = input.find("url");
            const auto raw = u && u->is_string() ? u->string() : u && u->is_null() ? std::string("null") : std::string("undefined");
            url = parse_url(raw);
        } catch (const std::exception &) { fail("Enter the full address of the app to notify, for example http://127.0.0.1:8765/stick."); }
        if (url.credentials || url.fragment || url.href.size() > 2048 || !(url.scheme == "https:" || (url.scheme == "http:" && loopback(url.host)))) {
            fail("Use HTTPS, or HTTP on this computer (127.0.0.1 or localhost), without a password in the address.");
        }
        return obj({{"id", str(id)}, {"name", str(name)}, {"event", str(*event)}, {"matcher", str(matcher)}, {"type", str("http")}, {"url", str(url.href)}, {"timeout", num(timeout)}, {"enabled", Value {enabled}}});
    }
    if (!type || *type != "command") { fail("Choose whether the hook runs a command or notifies an app."); }
    const auto *command = text(input, "command");
    if (!command || agent::js_trim(*command).empty() || utf16_length(*command) > 4096 || command->find('\0') != std::string::npos) { fail("Enter the command to run (under 4,096 characters)."); }
    return obj({{"id", str(id)}, {"name", str(name)}, {"event", str(*event)}, {"matcher", str(matcher)}, {"type", str("command")}, {"command", str(agent::js_trim(*command))}, {"timeout", num(timeout)}, {"enabled", Value {enabled}}});
}

struct Reply { std::optional<std::string> blocked; std::string context; std::optional<std::string> problem; };
// readReply: exit code 2 or {"decision":"block","reason":…} blocks; other text becomes notes for Stellan.
Reply read_reply(std::optional<int> status, const std::string &out, const std::string &err) {
    if (status && *status == 2) {
        const auto e = agent::js_trim(err), o = agent::js_trim(out);
        return {!e.empty() ? e : !o.empty() ? o : std::string("A hook blocked this."), "", std::nullopt};
    }
    if (!status || *status != 0) {
        const auto e = agent::js_trim(err);
        std::string problem = "exited with code " + (status ? std::to_string(*status) : std::string("unknown"));
        if (!e.empty()) { problem += ": " + e.substr(0, 300); }
        return {std::nullopt, "", problem};
    }
    const auto t = agent::js_trim(out);
    if (!t.empty() && t[0] == '{') {
        try {
            const auto value = json::parse(t);
            if (value.is_object()) {
                const auto *c = text(value, "additionalContext");
                const auto context = c ? *c : std::string();
                const auto *decision = text(value, "decision");
                if (decision && *decision == "block") { const auto *reason = text(value, "reason"); return {reason && !agent::js_trim(*reason).empty() ? agent::js_trim(*reason) : std::string("A hook blocked this."), context, std::nullopt}; }
                return {std::nullopt, context, std::nullopt};
            }
        } catch (const std::exception &) {}
    }
    return {std::nullopt, t, std::nullopt};
}

// Plain HTTP to a program on this computer (the only place hooks may use HTTP).
struct HttpResult { int status = 0; std::string body; };
HttpResult post_local(const Url &url, const std::string &body, int timeout_ms, const std::function<bool()> &cancelled) {
#ifdef _WIN32
    static const bool started = [] { WSADATA data; return WSAStartup(MAKEWORD(2, 2), &data) == 0; }(); (void)started;
#endif
    addrinfo hints {}; hints.ai_socktype = SOCK_STREAM; addrinfo *found = nullptr;
    const auto host = url.host == "[::1]" ? std::string("::1") : url.host;
    const auto port = url.port.empty() ? std::string("80") : url.port;
    if (getaddrinfo(host.c_str(), port.c_str(), &hints, &found) != 0 || !found) { throw std::runtime_error("fetch failed"); }
    const auto s = socket(found->ai_family, found->ai_socktype, found->ai_protocol);
#ifdef _WIN32
    DWORD wait = 200; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&wait), sizeof wait);
    const auto close_socket = [&] { closesocket(s); };
#else
    timeval wait {0, 200000}; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &wait, sizeof wait);
    const auto close_socket = [&] { close(s); };
#endif
    const bool connected = connect(s, found->ai_addr, static_cast<int>(found->ai_addrlen)) == 0;
    freeaddrinfo(found);
    if (!connected) { close_socket(); throw std::runtime_error("fetch failed"); }
    const auto head = "POST " + url.path + " HTTP/1.1\r\nHost: " + url.host + (url.port.empty() ? "" : ":" + url.port) + "\r\nContent-Type: application/json\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n";
    const auto message = head + body;
    for (std::size_t sent = 0; sent < message.size();) {
        const auto n = send(s, message.data() + sent, static_cast<int>(message.size() - sent), 0);
        if (n <= 0) { close_socket(); throw std::runtime_error("fetch failed"); }
        sent += static_cast<std::size_t>(n);
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
    std::string raw; char buffer[8192];
    for (;;) {
        if (cancelled()) { close_socket(); throw std::runtime_error("This operation was aborted"); }
        if (std::chrono::steady_clock::now() >= deadline) { close_socket(); throw std::runtime_error("The operation was aborted due to timeout"); }
        const auto n = recv(s, buffer, sizeof buffer, 0);
        if (n == 0) { break; }
        if (n < 0) { continue; } // receive timeout: check the deadline again
        raw.append(buffer, static_cast<std::size_t>(n));
        if (raw.size() > 16 * 1024 * 1024) { break; }
    }
    close_socket();
    const auto end = raw.find("\r\n\r\n");
    if (end == std::string::npos || raw.rfind("HTTP/1.", 0) != 0) { throw std::runtime_error("fetch failed"); }
    HttpResult result; result.status = std::atoi(raw.c_str() + raw.find(' ') + 1);
    const auto headers = lower(raw.substr(0, end));
    auto payload = raw.substr(end + 4);
    if (headers.find("transfer-encoding: chunked") != std::string::npos) {
        std::string decoded; std::size_t at = 0;
        for (;;) {
            const auto line = payload.find("\r\n", at); if (line == std::string::npos) { break; }
            const auto size = std::strtoul(payload.substr(at, line - at).c_str(), nullptr, 16);
            if (size == 0) { break; }
            decoded += payload.substr(line + 2, size); at = line + 2 + size + 2;
        }
        payload = decoded;
    }
    result.body = payload;
    return result;
}

Reply post(const Value &hook, const std::string &input, bool online, const std::string &roots, const std::function<bool()> &cancelled) {
    const auto url = parse_url(*text(hook, "url"));
    if (!online && !loopback(url.host)) { return {std::nullopt, "", std::string("was skipped because Allow internet is off")}; }
    const auto timeout_ms = static_cast<int>(std::get<double>(hook.find("timeout")->data) * 1000);
    int status = 0; std::string body;
    if (url.scheme == "http:") { const auto r = post_local(url, input, timeout_ms, cancelled); status = r.status; body = r.body; }
    else {
        https::Request request; request.method = "POST"; request.url = url.href; request.body = input; request.ca_file = roots; request.timeout_ms = timeout_ms; request.max_bytes = 16 * 1024 * 1024;
        request.headers = {{"Content-Type", "application/json"}};
        std::atomic<bool> done {false}; std::string error; https::Response response;
        std::thread worker([&] { try { response = https::request(request, [&](const char *d, std::size_t n) { body.append(d, n); }); } catch (const std::exception &) { error = "fetch failed"; } done = true; });
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
        while (!done) {
            if (cancelled()) { worker.detach(); throw std::runtime_error("This operation was aborted"); }
            if (std::chrono::steady_clock::now() >= deadline) { worker.detach(); throw std::runtime_error("The operation was aborted due to timeout"); }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        worker.join();
        if (!error.empty()) { throw std::runtime_error(error); }
        if (response.status >= 300 && response.status < 400) { throw std::runtime_error("fetch failed"); } // redirect: "error"
        status = response.status;
    }
    body = body.substr(0, output_limit);
    if (status < 200 || status >= 300) { return {std::nullopt, "", "got HTTP " + std::to_string(status) + " from " + url.host + (url.port.empty() ? "" : ":" + url.port)}; }
    return read_reply(0, body, "");
}

Reply command(const Value &hook, const std::string &event, const std::string &input, const std::string &project, const std::function<bool()> &cancelled) {
    process::Options o;
#ifdef _WIN32
    const char *comspec = std::getenv("ComSpec"); const char *system = std::getenv("SystemRoot");
    const std::string shell = comspec ? comspec : std::string(system ? system : "C:\\Windows") + "\\System32\\cmd.exe";
    auto base = lower(shell.substr(shell.find_last_of("\\/") + 1));
    if (base == "cmd.exe") { o.argv = {shell, "/d", "/s", "/c", "\"" + *text(hook, "command") + "\""}; o.windows_verbatim = true; }
    else {
        // PowerShell: -EncodedCommand takes base64 of the UTF-16LE command.
        std::u16string wide; const auto &c = *text(hook, "command");
        for (std::size_t i = 0; i < c.size();) { unsigned char b = static_cast<unsigned char>(c[i]); std::uint32_t cp; int n = b < 0x80 ? 1 : b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4; cp = n == 1 ? b : n == 2 ? b & 0x1F : n == 3 ? b & 0x0F : b & 0x07; for (int k = 1; k < n && i + k < c.size(); ++k) { cp = (cp << 6) | (static_cast<unsigned char>(c[i + k]) & 0x3F); } i += static_cast<std::size_t>(n); if (cp >= 0x10000) { cp -= 0x10000; wide += static_cast<char16_t>(0xD800 + (cp >> 10)); wide += static_cast<char16_t>(0xDC00 + (cp & 0x3FF)); } else { wide += static_cast<char16_t>(cp); } }
        std::string bytes; for (const auto ch : wide) { bytes += static_cast<char>(ch & 0xFF); bytes += static_cast<char>(ch >> 8); }
        static const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; std::string b64;
        for (std::size_t i = 0; i < bytes.size(); i += 3) { const std::uint32_t v = static_cast<unsigned char>(bytes[i]) << 16 | (i + 1 < bytes.size() ? static_cast<unsigned char>(bytes[i + 1]) << 8 : 0) | (i + 2 < bytes.size() ? static_cast<unsigned char>(bytes[i + 2]) : 0); b64 += alphabet[v >> 18 & 63]; b64 += alphabet[v >> 12 & 63]; b64 += i + 1 < bytes.size() ? alphabet[v >> 6 & 63] : '='; b64 += i + 2 < bytes.size() ? alphabet[v & 63] : '='; }
        o.argv = {shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", b64};
    }
#else
    o.argv = {"/bin/sh", "-c", *text(hook, "command")};
#endif
    o.cwd = project; o.input = input; o.output_limit = output_limit; o.cancelled = cancelled;
    o.timeout_ms = static_cast<int>(std::get<double>(hook.find("timeout")->data) * 1000);
    o.extra_env = {{"STICK_PROJECT_DIR", project}, {"STICK_HOOK_EVENT", event}};
    const auto r = process::run(o);
    if (!r.start_error.empty()) { return {std::nullopt, "", "couldn't start: " + r.start_error}; }
    switch (r.stop) {
        case process::Result::Stop::timeout: return {std::nullopt, "", "took longer than " + json::stringify(num(std::get<double>(hook.find("timeout")->data))) + " seconds and was stopped"};
        case process::Result::Stop::too_much_output: return {std::nullopt, "", std::string("wrote more than 64 KiB and was stopped")};
        case process::Result::Stop::cancelled: return {std::nullopt, "", std::string("was cancelled")};
        case process::Result::Stop::none: break;
    }
    return read_reply(r.status, r.out, r.err);
}
std::string reply_json(const Reply &r) {
    std::vector<std::pair<std::string, Value>> fields;
    if (r.blocked) { fields.emplace_back("blocked", str(*r.blocked)); }
    fields.emplace_back("context", str(r.context));
    if (r.problem) { fields.emplace_back("problem", str(*r.problem)); }
    return json::stringify(obj(fields));
}
}

// stellan-host --hook-config: {"input":…,"id":"hook-…"} on stdin; {"hook":…} or {"error":…} on stdout.
int hook_config() {
    std::string line; std::getline(std::cin, line);
    try {
        const auto request = json::parse(line);
        const auto *input = request.find("input"); const auto *id = text(request, "id");
        std::cout << json::stringify(obj({{"hook", config(input ? *input : Value {}, id ? *id : "")}})) << "\n";
    } catch (const HookError &error) { std::cout << json::stringify(obj({{"error", str(error.what())}})) << "\n"; }
    catch (const std::exception &) { std::cout << "{\"error\":\"Enter the hook's settings.\"}\n"; }
    return 0;
}

// stellan-host --run-hook ROOTS: one line {"hook","event","input","project","online"} on stdin, then nothing; closing
// stdin cancels the hook. Writes {"blocked"?,"context","problem"?} as hooks.ts's readReply and Hooks.run expect.
int run_hook(int argc, char **argv) {
    const std::string roots = argc > 2 ? argv[2] : "";
    std::string line;
    if (!std::getline(std::cin, line)) { return 1; }
    std::atomic<bool> cancelled {false};
    std::thread([&cancelled] { std::string rest; while (std::getline(std::cin, rest)) {} cancelled = true; }).detach();
    const auto is_cancelled = [&cancelled] { return cancelled.load(); };
    Reply reply;
    try {
        const auto request = json::parse(line);
        const auto hook = config(*request.find("hook"), *text(*request.find("hook"), "id"));
        const auto *event = text(request, "event"), *input = text(request, "input"), *project = text(request, "project");
        const auto *online = request.find("online");
        if (!event || !input || !project) { throw std::runtime_error("Invalid hook request"); }
        reply = *text(hook, "type") == "http" ? post(hook, *input, !(online && std::holds_alternative<bool>(online->data) && !std::get<bool>(online->data)), roots, is_cancelled)
                                              : command(hook, *event, *input, *project, is_cancelled);
    } catch (const std::exception &error) { reply = {std::nullopt, "", std::string(error.what())}; }
    std::cout << reply_json(reply) << "\n" << std::flush;
    std::_Exit(0); // the stdin watcher may still be waiting
}
}
