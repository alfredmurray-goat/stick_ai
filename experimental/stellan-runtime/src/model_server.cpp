#include "model_server.hpp"
#include "agent_core.hpp"
#include "json.hpp"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
namespace { using socket_t = SOCKET; constexpr socket_t invalid_socket = INVALID_SOCKET; void close_socket(socket_t s) { closesocket(s); } }
#else
#include <arpa/inet.h>
#include <csignal>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
namespace { using socket_t = int; constexpr socket_t invalid_socket = -1; void close_socket(socket_t s) { close(s); } }
#endif

// stellan-host --serve-model: Lite's and Max's local model server in Host, replacing portable/stellan-server.mjs.
// It answers the same routes with the same checks and messages, and runs the model through Host's own session mode
// (`stellan-host MODEL SHA THREADS CONTEXT --tagged`), whose native tokenizer matches tokenizer.mjs.
namespace stellan::model_server {
namespace {
using json::Value;
Value str(std::string s) { return Value {std::move(s)}; }
Value num(double d) { return Value {d}; }
Value obj(std::vector<std::pair<std::string, Value>> fields) { auto o = std::make_shared<json::Object>(); for (auto &f : fields) { o->push_back(std::move(f)); } return Value {o}; }
Value arr(std::vector<Value> items) { auto a = std::make_shared<json::Array>(); for (auto &i : items) { a->push_back(std::move(i)); } return Value {a}; }

// chatPrompt in stellan-server.mjs: Max carries the system text in its own block, Lite in the first user turn.
std::string chat_prompt(const Value *messages, bool max) {
    const auto fail = [] { throw std::runtime_error("Use bounded text messages with system, user or assistant roles"); };
    if (!messages || !messages->is_array() || messages->array().empty() || messages->array().size() > 1024) { fail(); }
    std::string system;
    std::vector<const Value *> turns;
    bool first_system = true;
    for (const auto &m : messages->array()) {
        if (!m.is_object()) { fail(); }
        const auto *role = m.find("role"), *content = m.find("content");
        if (!role || !role->is_string() || !content || !content->is_string()) { fail(); }
        const auto &r = role->string();
        if (r != "system" && r != "user" && r != "assistant") { fail(); }
        if (r == "system") { if (!first_system) { system += "\n\n"; } system += content->string(); first_system = false; }
        else { turns.push_back(&m); }
    }
    if (turns.empty() || turns[0]->find("role")->string() != "user") { throw std::runtime_error("A user message is required"); }
    std::string prompt = max ? "<s>[SYSTEM_PROMPT]" + system + "[/SYSTEM_PROMPT]" : "<s>";
    for (std::size_t i = 0; i < turns.size(); ++i) {
        const auto &content = turns[i]->find("content")->string();
        if (turns[i]->find("role")->string() == "user") { prompt += "[INST] " + (i == 0 && !max && !system.empty() ? system + "\n\n" : std::string()) + content + " [/INST]"; }
        else {
            // /^\s/: does the reply already start with JavaScript whitespace?
            const auto lead = content.empty() ? 0 : static_cast<unsigned char>(content[0]);
            const std::size_t width = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
            const bool spaced = !content.empty() && agent::js_trim(content.substr(0, std::min(width, content.size()))).empty();
            prompt += (spaced ? content : " " + content) + "</s>";
        }
    }
    if (prompt.size() > 1048576) { throw std::runtime_error("Shorten this conversation before continuing"); }
    return prompt;
}

// WHATWG UTF-8 decoding (TextDecoder with stream: true): invalid sequences become U+FFFD, a trailing incomplete
// sequence waits for the next bytes.
struct Utf8Stream {
    unsigned needed = 0, seen = 0, lower = 0x80, upper = 0xBF;
    std::string pending;
    std::string push(std::string_view bytes, bool end) {
        std::string out;
        const auto replacement = [&] { out += "\xEF\xBF\xBD"; };
        for (std::size_t i = 0; i <= bytes.size(); ++i) {
            if (i == bytes.size()) { break; }
            const auto b = static_cast<unsigned char>(bytes[i]);
            if (needed == 0) {
                if (b <= 0x7F) { out += static_cast<char>(b); continue; }
                if (b >= 0xC2 && b <= 0xDF) { needed = 1; }
                else if (b >= 0xE0 && b <= 0xEF) { if (b == 0xE0) { lower = 0xA0; } if (b == 0xED) { upper = 0x9F; } needed = 2; }
                else if (b >= 0xF0 && b <= 0xF4) { if (b == 0xF0) { lower = 0x90; } if (b == 0xF4) { upper = 0x8F; } needed = 3; }
                else { replacement(); continue; }
                pending.assign(1, static_cast<char>(b)); seen = 0;
                continue;
            }
            if (b < lower || b > upper) {
                needed = 0; seen = 0; lower = 0x80; upper = 0xBF; pending.clear(); replacement();
                --i; continue; // reprocess this byte
            }
            lower = 0x80; upper = 0xBF;
            pending += static_cast<char>(b);
            if (++seen == needed) { out += pending; pending.clear(); needed = 0; seen = 0; }
        }
        if (end && needed) { needed = 0; seen = 0; lower = 0x80; upper = 0xBF; pending.clear(); replacement(); }
        return out;
    }
};

std::string unhex(std::string_view hex) {
    std::string out;
    for (std::size_t i = 0; i + 1 < hex.size(); i += 2) { out += static_cast<char>(std::stoi(std::string(hex.substr(i, 2)), nullptr, 16)); }
    return out;
}
std::string hex(std::string_view bytes) {
    static const char digits[] = "0123456789abcdef";
    std::string out;
    for (const char c : bytes) { const auto b = static_cast<unsigned char>(c); out += digits[b >> 4]; out += digits[b & 15]; }
    return out;
}

// The model session: Host's own session mode as a child process, started on first use and again after it rests.
class Session {
public:
    Session(std::vector<std::string> args) : args_(std::move(args)) {}
    ~Session() { stop(); }
    void start() {
        if (running()) { return; }
#ifdef _WIN32
        SECURITY_ATTRIBUTES inherit {sizeof inherit, nullptr, TRUE};
        HANDLE in_read, out_write;
        if (!CreatePipe(&in_read, &in_, &inherit, 0) || !CreatePipe(&out_, &out_write, &inherit, 0)) { throw std::runtime_error("Cannot start the model"); }
        SetHandleInformation(in_, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(out_, HANDLE_FLAG_INHERIT, 0);
        std::wstring command;
        for (const auto &a : args_) {
            const auto w = std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(a.data()), a.size())).wstring();
            command += L"\"" + w + L"\" ";
        }
        STARTUPINFOW startup {}; startup.cb = sizeof startup; startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = in_read; startup.hStdOutput = out_write; startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        PROCESS_INFORMATION process {};
        if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) { throw std::runtime_error("Cannot start the model"); }
        CloseHandle(process.hThread); CloseHandle(in_read); CloseHandle(out_write);
        process_ = process.hProcess;
#else
        int in[2], out[2];
        if (pipe(in) != 0 || pipe(out) != 0) { throw std::runtime_error("Cannot start the model"); }
        pid_ = fork();
        if (pid_ < 0) { throw std::runtime_error("Cannot start the model"); }
        if (pid_ == 0) {
            dup2(in[0], 0); dup2(out[1], 1); close(in[0]); close(in[1]); close(out[0]); close(out[1]);
            std::vector<char *> argv; for (auto &a : args_) { argv.push_back(a.data()); } argv.push_back(nullptr);
            execv(argv[0], argv.data()); _exit(127);
        }
        close(in[0]); close(out[1]); in_ = in[1]; out_ = out[0];
#endif
        buffer_.clear();
        const auto ready = line();
        if (!ready || json::parse(*ready).find("event")->string() != "ready") { stop(); throw std::runtime_error("The model could not start. Check the model file and restart the app."); }
        std::cout << json::stringify(obj({{"event", str("model_process")}, {"pid", num(static_cast<double>(pid()))}})) << '\n' << std::flush;
    }
    bool running() const {
#ifdef _WIN32
        return process_ && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT;
#else
        return pid_ > 0 && waitpid(pid_, nullptr, WNOHANG) == 0;
#endif
    }
    long pid() const {
#ifdef _WIN32
        return process_ ? static_cast<long>(GetProcessId(process_)) : 0;
#else
        return pid_;
#endif
    }
    void write(const std::string &text) {
#ifdef _WIN32
        DWORD w = 0; std::size_t at = 0; while (at < text.size()) { if (!WriteFile(in_, text.data() + at, static_cast<DWORD>(text.size() - at), &w, nullptr)) { throw std::runtime_error("The model stopped"); } at += w; }
#else
        std::size_t at = 0; while (at < text.size()) { const auto n = ::write(in_, text.data() + at, text.size() - at); if (n <= 0) { throw std::runtime_error("The model stopped"); } at += static_cast<std::size_t>(n); }
#endif
    }
    std::optional<std::string> line() {
        for (;;) {
            if (const auto end = buffer_.find('\n'); end != std::string::npos) { auto l = buffer_.substr(0, end); buffer_.erase(0, end + 1); return l; }
            char chunk[65536];
#ifdef _WIN32
            DWORD got = 0; if (!ReadFile(out_, chunk, sizeof chunk, &got, nullptr) || got == 0) { return std::nullopt; }
#else
            const auto got = read(out_, chunk, sizeof chunk); if (got <= 0) { return std::nullopt; }
#endif
            buffer_.append(chunk, static_cast<std::size_t>(got));
        }
    }
    void stop() {
#ifdef _WIN32
        if (process_) { TerminateProcess(process_, 0); WaitForSingleObject(process_, 5000); CloseHandle(process_); CloseHandle(in_); CloseHandle(out_); process_ = nullptr; }
#else
        if (pid_ > 0) { kill(pid_, SIGKILL); waitpid(pid_, nullptr, 0); close(in_); close(out_); pid_ = -1; }
#endif
    }
private:
    std::vector<std::string> args_;
    std::string buffer_;
#ifdef _WIN32
    HANDLE process_ = nullptr, in_ = nullptr, out_ = nullptr;
#else
    pid_t pid_ = -1; int in_ = -1, out_ = -1;
#endif
};

struct Request { std::string method, path, body; std::vector<std::pair<std::string, std::string>> headers;
    const std::string *header(std::string_view name) const { for (const auto &[k, v] : headers) { if (k == name) { return &v; } } return nullptr; } };

bool send_all(socket_t s, std::string_view text) {
    std::size_t at = 0;
    while (at < text.size()) { const auto n = send(s, text.data() + at, static_cast<int>(text.size() - at), 0); if (n <= 0) { return false; } at += static_cast<std::size_t>(n); }
    return true;
}
void json_reply(socket_t s, int status, const Value &value) {
    const char *reason = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 401 ? "Unauthorized" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 409 ? "Conflict" : "Not Implemented";
    const auto body = json::stringify(value);
    send_all(s, "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
}
std::string lower(std::string s) { for (auto &c : s) { c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); } return s; }
// Reads one request: headers within 64 KiB, body (Content-Length only) up to 1 MiB.
std::optional<Request> read_request(socket_t s, bool &too_large) {
    std::string data; char chunk[16384];
    std::size_t end;
    while ((end = data.find("\r\n\r\n")) == std::string::npos) {
        if (data.size() > 65536) { return std::nullopt; }
        const auto n = recv(s, chunk, sizeof chunk, 0); if (n <= 0) { return std::nullopt; }
        data.append(chunk, static_cast<std::size_t>(n));
    }
    Request r;
    const auto line_end = data.find("\r\n");
    const auto first = data.substr(0, line_end);
    const auto a = first.find(' '), b = first.find(' ', a + 1);
    if (a == std::string::npos || b == std::string::npos) { return std::nullopt; }
    r.method = first.substr(0, a);
    auto target = first.substr(a + 1, b - a - 1);
    r.path = target.substr(0, target.find('?'));
    std::size_t at = line_end + 2;
    while (at < end) {
        const auto next = data.find("\r\n", at);
        const auto header = data.substr(at, next - at);
        if (const auto colon = header.find(':'); colon != std::string::npos) {
            auto value = header.substr(colon + 1);
            while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) { value.erase(0, 1); }
            while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) { value.pop_back(); }
            r.headers.emplace_back(lower(header.substr(0, colon)), value);
        }
        at = next + 2;
    }
    r.body = data.substr(end + 4);
    if (const auto *length = r.header("content-length")) {
        const auto wanted = std::stoull(*length);
        if (wanted > 1048576) { too_large = true; return r; }
        while (r.body.size() < wanted) { const auto n = recv(s, chunk, sizeof chunk, 0); if (n <= 0) { return std::nullopt; } r.body.append(chunk, static_cast<std::size_t>(n)); }
        r.body.resize(wanted);
    }
    return r;
}
bool same(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) { return false; }
    unsigned char diff = 0; for (std::size_t i = 0; i < a.size(); ++i) { diff |= static_cast<unsigned char>(a[i] ^ b[i]); }
    return diff == 0;
}

struct Server {
    Server(std::string k, std::string n, double c, std::vector<std::string> args) : key(std::move(k)), name(std::move(n)), context(c), session(std::move(args)) {}
    std::string key, name; double context; Session session; std::mutex busy_mutex; std::atomic<bool> busy {false}; double prompt_tokens = 0; bool has_metrics = false;
    void handle(socket_t client);
};

void Server::handle(socket_t client) {
    bool too_large = false;
    const auto request = read_request(client, too_large);
    if (!request) { close_socket(client); return; }
    const auto &r = *request;
    if (r.header("origin")) { json_reply(client, 403, obj({{"error", str("Browser origins are not accepted")}})); close_socket(client); return; }
    if (r.path == "/health" && r.method == "GET") { json_reply(client, 200, obj({{"status", str("ok")}, {"runtime", str("stellan-run")}})); close_socket(client); return; }
    std::string supplied = r.header("authorization") ? *r.header("authorization") : "";
    if (supplied.rfind("Bearer ", 0) == 0) { supplied.erase(0, 7); }
    if (!same(supplied, key)) { json_reply(client, 401, obj({{"error", str("Unauthorized")}})); close_socket(client); return; }
    if (r.path == "/v1/models" && r.method == "GET") { json_reply(client, 200, obj({{"data", arr({obj({{"id", str(name)}, {"owned_by", str("Locali Labs")}})})}})); close_socket(client); return; }
    if (r.path == "/slots" && r.method == "GET") { json_reply(client, 200, arr({obj({{"id", num(0)}, {"n_ctx", num(context)}, {"n_past", num(has_metrics ? prompt_tokens : 0)}, {"is_processing", Value {busy.load()}}})})); close_socket(client); return; }
    if (r.path == "/capabilities") { json_reply(client, 200, obj({{"runtime", str("Stellan-Run")}, {"compute", str("cpu")}, {"sampling", str("greedy")}, {"grammar", Value {false}}, {"slotPersistence", Value {false}}, {"splitModels", Value {true}}})); close_socket(client); return; }
    if (r.path.rfind("/slots/", 0) == 0) { json_reply(client, 501, obj({{"error", str("Stellan-Run re-reads prompts after model swaps; disk slot snapshots are unavailable")}})); close_socket(client); return; }
    if (r.method != "POST" || (r.path != "/v1/chat/completions" && r.path != "/completion" && r.path != "/apply-template")) { json_reply(client, 404, obj({{"error", str("Unknown endpoint")}})); close_socket(client); return; }
    Value input;
    try { if (too_large) { throw std::runtime_error("large"); } input = json::parse(r.body); }
    catch (const std::exception &) { json_reply(client, 400, obj({{"error", str("Use a valid JSON request under 1 MiB")}})); close_socket(client); return; }
    if (r.path == "/apply-template") {
        try { json_reply(client, 200, obj({{"prompt", str(chat_prompt(input.is_object() ? input.find("messages") : nullptr, name == "stellan-1-max"))}})); }
        catch (const std::exception &error) { json_reply(client, 400, obj({{"error", str(error.what())}})); }
        close_socket(client); return;
    }
    if (busy.exchange(true)) { json_reply(client, 409, obj({{"error", str("One Stellan-Run request is already active")}})); close_socket(client); return; }
    std::lock_guard lock(busy_mutex);
    bool streaming = false;
    const auto event = [&](const Value &v) { if (!send_all(client, "data: " + json::stringify(v) + "\n\n")) { throw std::runtime_error("client gone"); } };
    try {
        if (!input.is_object()) { throw std::runtime_error("Use text and a token limit from 0 to 4096"); }
        if (const auto *m = input.find("model"); m && !(m->is_string() && m->string() == name)) { throw std::runtime_error("This model is not loaded"); }
        const auto prompt = r.path == "/completion" ? (input.find("prompt") && input.find("prompt")->is_string() ? input.find("prompt")->string() : std::string("\x01invalid")) : chat_prompt(input.find("messages"), name == "stellan-1-max");
        const auto *limit = input.find("max_tokens"); if (!limit || limit->is_null()) { limit = input.find("n_predict"); }
        double max = 2048;
        if (limit && !limit->is_null()) { if (!std::holds_alternative<double>(limit->data)) { max = -1; } else { max = std::get<double>(limit->data); } }
        if (prompt == "\x01invalid" || max != std::floor(max) || max < 0 || max > 4096) { throw std::runtime_error("Use text and a token limit from 0 to 4096"); }
        session.start();
        if (r.path == "/v1/chat/completions") {
            send_all(client, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
            streaming = true;
            event(obj({{"choices", arr({obj({{"delta", obj({{"role", str("assistant")}})}})})}, {"stellan_runtime", obj({{"name", str("Stellan-Run")}, {"compute", str("cpu")}, {"sampling", str("greedy")}, {"grammar_enforced", Value {false}}})}}));
        }
        static unsigned next_id = 0;
        const auto id = ++next_id;
        session.write(std::to_string(id) + " " + std::to_string(static_cast<long long>(std::max(1.0, max))) + " " + hex(prompt) + "\n");
        Utf8Stream decoder;
        std::string text, last_text;
        std::vector<Value> tokens;
        Value finished;
        for (;;) {
            const auto line = session.line();
            if (!line) { session.stop(); throw std::runtime_error("Stellan-Run stopped. Try again."); }
            const auto e = json::parse(*line);
            const auto &kind = e.find("event")->string();
            if (kind == "rested") { continue; }
            if (kind == "error") { throw std::runtime_error(e.find("message")->string()); }
            if (kind == "prompt_progress" && r.path == "/v1/chat/completions") {
                event(obj({{"choices", arr({})}, {"prompt_progress", obj({{"processed", *e.find("completed")}, {"total", *e.find("total")}})}}));
            } else if (kind == "token") {
                tokens.push_back(*e.find("id"));
                const auto piece = decoder.push(unhex(e.find("bytes_hex")->string()), false);
                text += piece;
                if (r.path == "/v1/chat/completions" && !piece.empty() && name == "stellan-1-max") {
                    event(obj({{"choices", arr({obj({{"delta", obj({{"content", str(piece)}})}})})}}));
                } else if (r.path == "/v1/chat/completions" && !piece.empty()) {
                    if (!last_text.empty()) { event(obj({{"choices", arr({obj({{"delta", obj({{"content", str(last_text)}})}})})}})); }
                    last_text = piece;
                }
            } else if (kind == "finished") { text += decoder.push("", true); finished = e; break; }
        }
        const double reused = std::get<double>(finished.find("reused_tokens")->data), evaluated = std::get<double>(finished.find("evaluated_prompt_tokens")->data);
        prompt_tokens = reused + evaluated; has_metrics = true;
        const double completion = max == 0 ? 0 : static_cast<double>(tokens.size());
        if (r.path == "/completion") {
            json_reply(client, 200, obj({{"content", str(max == 0 ? "" : text)}, {"tokens", max == 0 ? arr({}) : arr(tokens)}, {"timings", finished}}));
        } else {
            if (!last_text.empty()) { event(obj({{"choices", arr({obj({{"delta", obj({{"content", str(last_text)}})}})})}})); }
            const auto &stop = finished.find("stop_reason")->string();
            const auto reason = stop == "length" ? "length" : !stop.empty() ? "stop" : static_cast<double>(tokens.size()) >= max ? "length" : "stop";
            event(obj({{"choices", arr({obj({{"delta", obj({})}, {"finish_reason", str(reason)}})})}, {"usage", obj({{"prompt_tokens", num(prompt_tokens)}, {"completion_tokens", num(completion)}})}}));
            send_all(client, "data: [DONE]\n\n");
        }
    } catch (const std::exception &error) {
        const std::string message = error.what();
        if (message == "client gone") { session.stop(); } // the reader left mid-reply: end that request, as Node's abort does
        else if (!streaming) { json_reply(client, 400, obj({{"error", str(message)}})); }
        else { send_all(client, "data: " + json::stringify(obj({{"error", obj({{"message", str(message)}})}})) + "\n\n"); }
    }
    busy = false;
    close_socket(client);
}
}

// stellan-host --serve-model HOST_EXE MODEL SHA256 THREADS CONTEXT PORT KEY_FILE MODEL_NAME [--split PATH SHA256]
int serve(int argc, char **argv) {
    if (argc < 10) { throw std::runtime_error("Usage: stellan-host --serve-model HOST MODEL SHA256 THREADS CONTEXT PORT KEY_FILE MODEL_NAME [--split PATH SHA256]"); }
    std::ifstream key_file(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(argv[8]))), std::ios::binary);
    std::string key((std::istreambuf_iterator<char>(key_file)), std::istreambuf_iterator<char>());
    while (!key.empty() && (key.back() == '\n' || key.back() == '\r' || key.back() == ' ')) { key.pop_back(); }
    if (key.size() < 32) { throw std::runtime_error("A private server key is required"); }
    const std::string model_name = argv[9];
    if (model_name != "stellan-1-lite" && model_name != "stellan-1-max") { throw std::runtime_error("Host serves Stellan-1 Lite and Max only"); }
    // Tagged stopping follows Lite's tool protocol; Max runs plain completions, as in stellan-server.mjs.
    std::vector<std::string> args {argv[2], argv[3], argv[4], argv[5], argv[6]};
    if (model_name == "stellan-1-lite") { args.emplace_back("--tagged"); }
    for (int i = 10; i < argc; ++i) { args.emplace_back(argv[i]); }
    auto server = std::make_unique<Server>(key, argv[9], std::stod(argv[6]), args);
#ifdef _WIN32
    WSADATA data; WSAStartup(MAKEWORD(2, 2), &data);
#else
    std::signal(SIGPIPE, SIG_IGN);
#endif
    server->session.start();
    const socket_t listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int yes = 1; setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char *>(&yes), sizeof yes);
    sockaddr_in address {}; address.sin_family = AF_INET; address.sin_port = htons(static_cast<unsigned short>(std::stoi(argv[7]))); address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (listener == invalid_socket || bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof address) != 0 || listen(listener, 16) != 0) { throw std::runtime_error("Cannot listen on the model port"); }
    std::cout << "{\"event\":\"ready\"}\n" << std::flush;
    // The app closes stdin to stop the server.
    std::thread([&] { std::string ignored; while (std::getline(std::cin, ignored)) {} server->session.stop(); std::exit(0); }).detach();
    std::atomic<int> active {0};
    for (;;) {
        const socket_t client = accept(listener, nullptr, nullptr);
        if (client == invalid_socket) { continue; }
        if (active.load() >= 8) { close_socket(client); continue; }
        ++active;
        std::thread([&, client] { server->handle(client); --active; }).detach();
    }
}
}
