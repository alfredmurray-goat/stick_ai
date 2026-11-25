#include "mcp_client.hpp"
#include "json.hpp"
#include "mcp_wire.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <io.h>
#include <windows.h>
#else
#include <csignal>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

// stellan-host --mcp-client: Stellan-Link's request lifecycle (src/portable/mcp-rpc.ts) and stdio transport
// (mcp-process.ts, mcp-lines.ts) in Host. The app sends one JSON command per line:
//   {"id":N,"op":"connect"} | {"id":N,"op":"request","method":M,"params":{}} | {"id":N,"op":"cancel"} | {"op":"close"}
// and receives {"id":N,"result":...} / {"id":N,"error":"..."} replies plus {"event":"notification",...} and
// {"event":"closed","message":...}. The MCP program runs in Host's process group (POSIX) or job object (Windows), so it
// ends with Host; file descriptor 3 is the app's lifeline, as for --mcp-bridge.
namespace stellan::mcp {
namespace {
using json::Value;
constexpr std::size_t line_limit = 4 * 1024 * 1024, budget = 4 * 1024 * 1024;
const char *const protocol_version = "2025-11-25";
const char *const protocol_versions[] = {"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"};
Value str(std::string s) { return Value {std::move(s)}; }
Value obj(std::vector<std::pair<std::string, Value>> fields) { auto o = std::make_shared<json::Object>(); for (auto &f : fields) { o->push_back(std::move(f)); } return Value {o}; }

void valid_utf8(std::string_view s) {
    for (std::size_t i = 0; i < s.size(); ++i) {
        const auto first = static_cast<unsigned char>(s[i]); if (first < 128) { continue; }
        const auto count = first >= 0xc2 && first <= 0xdf ? 1U : first >= 0xe0 && first <= 0xef ? 2U : first >= 0xf0 && first <= 0xf4 ? 3U : 0U;
        if (!count || s.size() - i - 1 < count) { throw std::runtime_error("Invalid UTF-8"); }
        unsigned code = first & ((1U << (6 - count)) - 1);
        for (unsigned j = 0; j < count; ++j) { const auto next = static_cast<unsigned char>(s[++i]); if ((next & 0xc0) != 0x80) { throw std::runtime_error("Invalid UTF-8"); } code = (code << 6) | (next & 63); }
        if (code < (count == 1 ? 128U : count == 2 ? 2048U : 65536U) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) { throw std::runtime_error("Invalid UTF-8"); }
    }
}

#ifdef _WIN32
using Pipe = HANDLE;
bool write_all(Pipe p, const std::string &s) { DWORD w = 0; std::size_t at = 0; while (at < s.size()) { if (!WriteFile(p, s.data() + at, static_cast<DWORD>(s.size() - at), &w, nullptr)) { return false; } at += w; } return true; }
long read_some(Pipe p, char *buffer, std::size_t size) { DWORD got = 0; if (!ReadFile(p, buffer, static_cast<DWORD>(size), &got, nullptr)) { return 0; } return static_cast<long>(got); }
HANDLE job = nullptr;
[[noreturn]] void end_all(int code) { if (job) { TerminateJobObject(job, 0); } std::cout.flush(); ExitProcess(static_cast<UINT>(code)); }
#else
using Pipe = int;
bool write_all(Pipe p, const std::string &s) { std::size_t at = 0; while (at < s.size()) { const auto n = write(p, s.data() + at, s.size() - at); if (n < 0) { if (errno == EINTR) { continue; } return false; } at += static_cast<std::size_t>(n); } return true; }
long read_some(Pipe p, char *buffer, std::size_t size) { for (;;) { const auto n = read(p, buffer, size); if (n < 0 && errno == EINTR) { continue; } return n < 0 ? 0 : static_cast<long>(n); } }
[[noreturn]] void end_all(int code) { std::cout.flush(); std::signal(SIGTERM, SIG_DFL); kill(-getpgrp(), SIGKILL); _exit(code); }
#endif

struct Child { Pipe in, out; };

class Client {
public:
    explicit Client(Child child) : child_(child) {}
    void run();
private:
    struct Pending { std::optional<double> app_id; std::size_t bytes; bool initialize = false; };
    Child child_;
    std::mutex mutex_;
    std::mutex output_;
    std::condition_variable writable_;
    std::deque<std::pair<std::string, std::optional<double>>> queue_; // line, request id whose write this settles
    std::map<double, Pending> pending_;
    std::map<double, double> by_app_; // app id -> MCP request id
    double next_ = 0;
    std::size_t pending_bytes_ = 0, responding_ = 0;
    bool closed_ = false, ready_ = false, connecting_ = false;
    std::optional<double> connect_app_;

    void send_app(const Value &v) { std::lock_guard lock(output_); std::cout << json::stringify(v) << '\n'; std::cout.flush(); }
    void reply(double app, const Value &result) { send_app(obj({{"id", Value {app}}, {"result", result}})); }
    void fail(double app, const std::string &message) { send_app(obj({{"id", Value {app}}, {"error", str(message)}})); }
    void enqueue(std::string line, std::optional<double> settles) { queue_.emplace_back(std::move(line), settles); writable_.notify_one(); }
    [[noreturn]] void finish(const std::string &message) {
        {
            std::lock_guard lock(mutex_);
            closed_ = true;
            for (const auto &[id, entry] : pending_) { if (entry.app_id) { fail(*entry.app_id, message); } }
            pending_.clear();
            if (connect_app_) { fail(*connect_app_, message); connect_app_.reset(); }
        }
        send_app(obj({{"event", str("closed")}, {"message", str(message)}}));
        end_all(0);
    }
    // McpRpc.request: same order of checks and the same messages.
    std::optional<std::string> request(const std::string &method, const Value &params, std::optional<double> app, bool initialize) {
        if (closed_) { return std::string("Connect this MCP server first."); }
        if (pending_.size() >= 64 || queue_.size() >= 64) { return std::string("Too many MCP requests are waiting. Wait for a response or reconnect the server."); }
        const double id = next_ + 1;
        auto with_meta = std::make_shared<json::Object>();
        bool placed = false;
        const auto meta = obj({{"progressToken", str(json::stringify(Value {id}))}});
        for (const auto &[key, value] : params.object()) {
            if (key == "_meta") { with_meta->emplace_back(key, meta); placed = true; } else { with_meta->emplace_back(key, value); }
        }
        if (!placed) { with_meta->emplace_back("_meta", meta); }
        const auto message = obj({{"jsonrpc", str("2.0")}, {"id", Value {id}}, {"method", str(method)}, {"params", Value {with_meta}}});
        try { parse_message(message); } catch (const WireError &error) { return std::string(error.what()); }
        const auto text = json::stringify(message);
        if (text.size() > budget - pending_bytes_) { return std::string("MCP requests exceed the 4 MiB in-flight budget. Wait for a response or reconnect the server."); }
        next_ = id;
        pending_bytes_ += text.size();
        pending_[id] = {app, text.size(), initialize};
        if (app) { by_app_[*app] = id; }
        enqueue(text + "\n", std::nullopt);
        return std::nullopt;
    }
    void settle(double id) {
        const auto found = pending_.find(id);
        if (found == pending_.end()) { return; }
        pending_bytes_ -= found->second.bytes;
        if (found->second.app_id) { by_app_.erase(*found->second.app_id); }
        pending_.erase(found);
    }
    void receive(const Value &message);
    void command(const Value &input);
    void writer();
    void reader();
};

void Client::receive(const Value &message) {
    std::unique_lock lock(mutex_);
    if (closed_) { return; }
    if (const auto *method = message.find("method")) {
        if (const auto *id = message.find("id")) {
            const auto answer = method->string() == "ping"
                ? obj({{"jsonrpc", str("2.0")}, {"id", *id}, {"result", obj({})}})
                : obj({{"jsonrpc", str("2.0")}, {"id", *id}, {"error", obj({{"code", Value {-32601.0}}, {"message", str("This client does not enable sampling or elicitation.")}})}});
            const auto text = json::stringify(answer);
            // A server must not turn slow writes into an unbounded reply queue.
            if (responding_ >= 16 || text.size() > budget - pending_bytes_) { lock.unlock(); finish("MCP connection closed."); }
            ++responding_; pending_bytes_ += text.size();
            queue_.emplace_back(text + "\n", -static_cast<double>(text.size()));
            writable_.notify_one();
        } else {
            const auto *params = message.find("params");
            lock.unlock();
            send_app(obj({{"event", str("notification")}, {"method", *method}, {"params", params ? *params : obj({})}}));
        }
        return;
    }
    const auto *id = message.find("id");
    if (!id || !std::holds_alternative<double>(id->data)) { return; }
    const auto key = std::get<double>(id->data);
    const auto found = pending_.find(key);
    if (found == pending_.end()) { return; }
    const auto entry = found->second;
    settle(key);
    if (message.find("error")) {
        if (entry.initialize) { lock.unlock(); const auto app = *connect_app_; connect_app_.reset(); fail(app, "MCP server request failed. Check its configuration and tool arguments."); finish("MCP connection closed."); }
        lock.unlock();
        if (entry.app_id) { fail(*entry.app_id, "MCP server request failed. Check its configuration and tool arguments."); }
        return;
    }
    const auto &result = *message.find("result");
    if (entry.initialize) {
        const auto app = *connect_app_;
        std::string problem;
        Value init;
        try {
            init = parse_initialization(result);
            const auto &version = init.find("protocolVersion")->string();
            if (std::none_of(std::begin(protocol_versions), std::end(protocol_versions), [&](const char *v) { return version == v; })) { problem = "This MCP protocol version is unsupported."; }
            else if (!init.find("capabilities")->find("tools")) { problem = "This server does not provide MCP tools."; }
        } catch (const std::exception &error) { problem = error.what(); }
        if (!problem.empty()) { connect_app_.reset(); lock.unlock(); fail(app, problem); finish("MCP connection closed."); }
        enqueue(json::stringify(obj({{"jsonrpc", str("2.0")}, {"method", str("notifications/initialized")}})) + "\n", std::nullopt);
        ready_ = true; connecting_ = false; connect_app_.reset();
        lock.unlock();
        reply(app, init);
        return;
    }
    lock.unlock();
    if (entry.app_id) { reply(*entry.app_id, result); }
}

void Client::command(const Value &input) {
    const auto *op = input.find("op");
    const auto *id = input.find("id");
    const double app = id && std::holds_alternative<double>(id->data) ? std::get<double>(id->data) : 0;
    const auto &name = op && op->is_string() ? op->string() : std::string();
    if (name == "close") { finish("MCP connection closed."); }
    std::unique_lock lock(mutex_);
    if (name == "connect") {
        if (closed_ || ready_ || connecting_) { lock.unlock(); fail(app, "This MCP connection is already started or closed. Reconnect it in settings."); return; }
        connecting_ = true; connect_app_ = app;
        const auto params = obj({{"protocolVersion", str(protocol_version)}, {"capabilities", obj({})}, {"clientInfo", obj({{"name", str("stick-ai")}, {"version", str("0.2.0")}})}});
        if (const auto problem = request("initialize", params, std::nullopt, true)) { connect_app_.reset(); lock.unlock(); fail(app, *problem); finish("MCP connection closed."); }
        return;
    }
    if (name == "request") {
        const auto *method = input.find("method"), *params = input.find("params");
        if (!method || !method->is_string() || !params || !params->is_object()) { lock.unlock(); fail(app, "Invalid MCP request."); return; }
        if (const auto problem = request(method->string(), *params, app, false)) { lock.unlock(); fail(app, *problem); }
        return;
    }
    if (name == "cancel") {
        // McpRpc: a cancelled request is dropped, the server is told, and the connection closes.
        const auto found = by_app_.find(app);
        if (found != by_app_.end()) {
            const auto target = found->second;
            settle(target);
            write_all(child_.in, json::stringify(obj({{"jsonrpc", str("2.0")}, {"method", str("notifications/cancelled")}, {"params", obj({{"requestId", Value {target}}, {"reason", str("Cancelled by user")}})}})) + "\n");
        }
        lock.unlock();
        finish("MCP connection closed.");
    }
    lock.unlock();
    fail(app, "Unknown MCP command.");
}

void Client::writer() {
    for (;;) {
        std::pair<std::string, std::optional<double>> item;
        {
            std::unique_lock lock(mutex_);
            writable_.wait(lock, [&] { return !queue_.empty() || closed_; });
            if (closed_) { return; }
            item = queue_.front();
        }
        const bool ok = write_all(child_.in, item.first);
        {
            std::lock_guard lock(mutex_);
            queue_.pop_front();
            if (item.second && *item.second < 0) { --responding_; pending_bytes_ -= static_cast<std::size_t>(-*item.second); }
        }
        if (!ok) { finish("The MCP server disconnected. Reconnect it in settings."); }
    }
}

void Client::reader() {
    // McpLines: bounded NDJSON framing; empty lines are skipped. Each line must be strict UTF-8 (a leading BOM is
    // dropped, as TextDecoder does) and a valid MCP envelope, or the connection closes.
    std::string line;
    char buffer[65536];
    for (;;) {
        const auto got = read_some(child_.out, buffer, sizeof buffer);
        if (got <= 0) { finish("The MCP server disconnected. Reconnect it in settings."); }
        std::size_t start = 0;
        for (std::size_t i = 0; i < static_cast<std::size_t>(got); ++i) {
            if (buffer[i] != '\n') { continue; }
            line.append(buffer + start, i - start);
            start = i + 1;
            if (line.size() > line_limit) { finish("MCP connection closed."); }
            if (!line.empty()) {
                try {
                    std::string_view text(line);
                    if (text.substr(0, 3) == "\xEF\xBB\xBF") { text.remove_prefix(3); }
                    valid_utf8(text);
                    const auto message = json::parse(text);
                    parse_message(message);
                    receive(message);
                } catch (const std::exception &) { finish("MCP connection closed."); }
            }
            line.clear();
        }
        line.append(buffer + start, static_cast<std::size_t>(got) - start);
        if (line.size() > line_limit) { finish("MCP connection closed."); }
    }
}

void Client::run() {
    std::thread([this] { writer(); }).detach();
    std::thread([this] { reader(); }).detach();
    std::string line;
    while (std::getline(std::cin, line)) {
        try { command(json::parse(line)); }
        catch (const std::exception &) { finish("MCP connection closed."); }
    }
    finish("MCP connection closed.");
}
}

#ifdef _WIN32
namespace {
std::wstring wide(const char *utf8) {
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, nullptr, 0);
    if (length <= 0) { throw std::runtime_error("Invalid MCP client argument"); }
    std::wstring result(static_cast<std::size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, result.data(), length);
    result.resize(static_cast<std::size_t>(length - 1));
    return result;
}
DWORD WINAPI watch_lifeline(void *handle) {
    char buffer[64]; DWORD got = 0;
    while (ReadFile(static_cast<HANDLE>(handle), buffer, sizeof buffer, &got, nullptr) && got > 0) {}
    end_all(0);
}
}
// stellan-host --mcp-client CWD --cmdline APPLICATION COMMAND_LINE (quoting as for --mcp-bridge).
int mcp_client(int argc, char **argv) {
    if (argc != 6 || std::string(argv[3]) != "--cmdline") { throw std::runtime_error("Usage: stellan-host --mcp-client CWD --cmdline APPLICATION COMMAND_LINE"); }
    const auto cwd = wide(argv[2]), application = wide(argv[4]);
    auto command = wide(argv[5]);
    job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) { throw std::runtime_error("Cannot create the MCP job object"); }
    SECURITY_ATTRIBUTES inherit {sizeof inherit, nullptr, TRUE};
    HANDLE in_read, in_write, out_read, out_write;
    if (!CreatePipe(&in_read, &in_write, &inherit, 0) || !CreatePipe(&out_read, &out_write, &inherit, 0)) { throw std::runtime_error("Cannot create MCP pipes"); }
    SetHandleInformation(in_write, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0);
    HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
    SetHandleInformation(error, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    HANDLE handles[3] = {in_read, out_write, error};
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<unsigned char> storage(size);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size) || !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof handles, nullptr, nullptr)) {
        throw std::runtime_error("Cannot prepare the MCP program's handles");
    }
    STARTUPINFOEXW startup {};
    startup.StartupInfo.cb = sizeof startup;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = in_read; startup.StartupInfo.hStdOutput = out_write; startup.StartupInfo.hStdError = error;
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process {};
    if (!CreateProcessW(application.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, cwd.c_str(), &startup.StartupInfo, &process)) {
        DeleteProcThreadAttributeList(attributes);
        std::cerr << "The MCP program could not be started. Check its executable and arguments.\n";
        return 127;
    }
    DeleteProcThreadAttributeList(attributes);
    if (!AssignProcessToJobObject(job, process.hProcess)) { TerminateProcess(process.hProcess, 1); throw std::runtime_error("Cannot supervise the MCP program"); }
    ResumeThread(process.hThread); CloseHandle(process.hThread);
    CloseHandle(in_read); CloseHandle(out_write);
    const auto lifeline = reinterpret_cast<HANDLE>(_get_osfhandle(3));
    if (lifeline != INVALID_HANDLE_VALUE) { if (HANDLE thread = CreateThread(nullptr, 0, watch_lifeline, lifeline, 0, nullptr)) { CloseHandle(thread); } }
    Client client({in_write, out_read});
    client.run();
    return 0;
}
#else
// stellan-host --mcp-client CWD -- PROGRAM [ARGS...]
int mcp_client(int argc, char **argv) {
    if (argc < 5 || std::string(argv[3]) != "--") { throw std::runtime_error("Usage: stellan-host --mcp-client CWD -- PROGRAM [ARGS...]"); }
    const char *cwd = argv[2];
    if (getpgrp() != getpid() && setpgid(0, 0) != 0) { throw std::runtime_error("Cannot create the MCP process group"); }
    std::signal(SIGPIPE, SIG_IGN);
    int in[2], out[2];
    if (pipe(in) != 0 || pipe(out) != 0) { throw std::runtime_error("Cannot create MCP pipes"); }
    const pid_t child = fork();
    if (child < 0) { throw std::runtime_error("Cannot start the MCP program"); }
    if (child == 0) {
        std::signal(SIGPIPE, SIG_DFL);
        dup2(in[0], 0); dup2(out[1], 1);
        close(in[0]); close(in[1]); close(out[0]); close(out[1]); close(3);
        if (chdir(cwd) != 0) { static const char m[] = "The MCP program's folder could not be opened.\n"; (void)!write(2, m, sizeof m - 1); _exit(126); }
        std::vector<char *> args(argv + 4, argv + argc);
        args.push_back(nullptr);
        execvp(args[0], args.data());
        static const char m[] = "The MCP program could not be started. Check its executable and arguments.\n";
        (void)!write(2, m, sizeof m - 1);
        _exit(127);
    }
    close(in[0]); close(out[1]);
    // The app's lifeline: when it closes (or the app dies), everything in this process group ends.
    std::thread([] {
        pollfd lifeline {3, POLLIN, 0};
        char drain[64];
        for (;;) {
            const int ready = poll(&lifeline, 1, -1);
            if (ready < 0 && errno == EINTR) { continue; }
            if (ready < 0 || (lifeline.revents & (POLLHUP | POLLERR | POLLNVAL))) { end_all(0); }
            if ((lifeline.revents & POLLIN) && read(3, drain, sizeof drain) <= 0) { end_all(0); }
        }
    }).detach();
    Client client({in[1], out[0]});
    client.run();
    return 0;
}
#endif
}
