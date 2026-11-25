#include "mcp_bridge.hpp"

#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <io.h>
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <cstring>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace stellan {
#ifdef _WIN32
namespace {
std::wstring wide(const char *utf8) {
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, nullptr, 0);
    if (length <= 0) { throw std::runtime_error("Invalid MCP bridge argument"); }
    std::wstring result(static_cast<std::size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, result.data(), length);
    result.resize(static_cast<std::size_t>(length - 1));
    return result;
}
HANDLE job = nullptr;
// The app closed its lifeline (or exited): end the job, which ends the program and everything it started.
DWORD WINAPI watch_lifeline(void *handle) {
    char buffer[64];
    DWORD got = 0;
    while (ReadFile(static_cast<HANDLE>(handle), buffer, sizeof buffer, &got, nullptr) && got > 0) {}
    TerminateJobObject(job, 0);
    ExitProcess(0);
}
}

// stellan-host --mcp-bridge CWD --cmdline APPLICATION COMMAND_LINE
// The app resolves APPLICATION through PATH/PATHEXT (never the project folder) and builds COMMAND_LINE with the
// same quoting and batch-file escaping it uses itself. The program runs inside a job object that is ended when the
// bridge exits, when the program exits, or when the app's lifeline (CRT file descriptor 3) closes.
int mcp_bridge(int argc, char **argv) {
    if (argc != 6 || std::string(argv[3]) != "--cmdline") { throw std::runtime_error("Usage: stellan-host --mcp-bridge CWD --cmdline APPLICATION COMMAND_LINE"); }
    const auto cwd = wide(argv[2]), application = wide(argv[4]);
    auto command = wide(argv[5]);
    job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) { throw std::runtime_error("Cannot create the MCP job object"); }
    HANDLE std_handles[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
    for (auto handle : std_handles) { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT); }
    // Only the three standard handles are inherited; the lifeline and everything else stay with the bridge.
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<unsigned char> storage(size);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size) ||
        !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, std_handles, sizeof std_handles, nullptr, nullptr)) {
        throw std::runtime_error("Cannot prepare the MCP program's handles");
    }
    STARTUPINFOEXW startup {};
    startup.StartupInfo.cb = sizeof startup;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = std_handles[0];
    startup.StartupInfo.hStdOutput = std_handles[1];
    startup.StartupInfo.hStdError = std_handles[2];
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process {};
    if (!CreateProcessW(application.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                        nullptr, cwd.c_str(), &startup.StartupInfo, &process)) {
        DeleteProcThreadAttributeList(attributes);
        static const char message[] = "The MCP program could not be started. Check its executable and arguments.\n";
        DWORD written = 0;
        WriteFile(std_handles[2], message, sizeof message - 1, &written, nullptr);
        return 127;
    }
    DeleteProcThreadAttributeList(attributes);
    if (!AssignProcessToJobObject(job, process.hProcess)) {
        TerminateProcess(process.hProcess, 1);
        throw std::runtime_error("Cannot supervise the MCP program");
    }
    ResumeThread(process.hThread);
    CloseHandle(process.hThread);
    const auto lifeline = reinterpret_cast<HANDLE>(_get_osfhandle(3));
    if (lifeline != INVALID_HANDLE_VALUE) {
        if (HANDLE thread = CreateThread(nullptr, 0, watch_lifeline, lifeline, 0, nullptr)) { CloseHandle(thread); }
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    TerminateJobObject(job, 0); // leftover descendants
    return static_cast<int>(code);
}
#else
namespace {
volatile std::sig_atomic_t stop_requested = 0;
void request_stop(int) { stop_requested = 1; }
// Ends the MCP program and everything it started: the bridge leads the process group they all share.
[[noreturn]] void end_group(int code) {
    std::signal(SIGTERM, SIG_DFL);
    kill(-getpgrp(), SIGKILL);
    _exit(code);
}
}

// stellan-host --mcp-bridge CWD -- PROGRAM [ARGS...]
// Replaces a Node bridge process per MCP server (about 47 MB each) with a native one. The program inherits
// stdin, stdout and stderr directly, so no bytes are copied through the bridge. File descriptor 3 is the
// owner's lifeline: when the app closes it (or dies), the bridge ends the whole process group.
int mcp_bridge(int argc, char **argv) {
    if (argc < 5 || std::string(argv[3]) != "--") { throw std::runtime_error("Usage: stellan-host --mcp-bridge CWD -- PROGRAM [ARGS...]"); }
    const char *cwd = argv[2];
    if (getpgrp() != getpid() && setpgid(0, 0) != 0) { throw std::runtime_error("Cannot create the MCP process group"); }
    struct sigaction action {};
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, nullptr);
    sigaction(SIGINT, &action, nullptr);
    const pid_t child = fork();
    if (child < 0) { throw std::runtime_error("Cannot start the MCP program"); }
    if (child == 0) {
        std::signal(SIGTERM, SIG_DFL);
        std::signal(SIGINT, SIG_DFL);
        close(3);
        if (chdir(cwd) != 0) {
            static const char message[] = "The MCP program's folder could not be opened.\n";
            (void)!write(2, message, sizeof message - 1);
            _exit(126);
        }
        std::vector<char *> args(argv + 4, argv + argc);
        args.push_back(nullptr);
        execvp(args[0], args.data());
        static const char message[] = "The MCP program could not be started. Check its executable and arguments.\n";
        (void)!write(2, message, sizeof message - 1);
        _exit(127);
    }
    // The program does not need the lifeline; only the bridge watches it.
    pollfd lifeline {3, POLLIN, 0};
    char drain[64];
    for (;;) {
        if (stop_requested) { end_group(0); }
        int status = 0;
        const pid_t done = waitpid(child, &status, WNOHANG);
        if (done == child) { end_group(WIFEXITED(status) ? WEXITSTATUS(status) : 1); }
        const int ready = poll(&lifeline, 1, 200);
        if (ready < 0 && errno != EINTR) { end_group(1); }
        if (ready > 0) {
            if (lifeline.revents & (POLLHUP | POLLERR | POLLNVAL)) { end_group(0); }
            if (lifeline.revents & POLLIN) {
                const auto got = read(3, drain, sizeof drain);
                if (got <= 0) { end_group(0); }
            }
        }
    }
}
#endif
}
