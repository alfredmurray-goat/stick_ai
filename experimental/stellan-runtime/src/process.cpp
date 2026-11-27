#include "process.hpp"

#include <atomic>
#include <chrono>
#include <cstring>
#include <thread>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace stellan::process {
namespace {
using Clock = std::chrono::steady_clock;
}

#ifdef _WIN32
namespace {
std::wstring widen(const std::string &s) {
    if (s.empty()) { return {}; }
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<std::size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}
// Standard Windows argument quoting (as Node does without windowsVerbatimArguments).
std::wstring quote(const std::wstring &arg) {
    if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) { return arg; }
    std::wstring out = L"\"";
    for (std::size_t i = 0;; ++i) {
        std::size_t slashes = 0;
        while (i < arg.size() && arg[i] == L'\\') { ++slashes; ++i; }
        if (i == arg.size()) { out.append(slashes * 2, L'\\'); break; }
        if (arg[i] == L'"') { out.append(slashes * 2 + 1, L'\\'); out += L'"'; } else { out.append(slashes, L'\\'); out += arg[i]; }
    }
    return out + L"\"";
}
}

Result run(const Options &o) {
    Result result;
    SECURITY_ATTRIBUTES inherit {sizeof inherit, nullptr, TRUE};
    HANDLE in_read = nullptr, in_write = nullptr, out_read = nullptr, out_write = nullptr, err_read = nullptr, err_write = nullptr;
    if (!CreatePipe(&in_read, &in_write, &inherit, 0) || !CreatePipe(&out_read, &out_write, &inherit, 0) || !CreatePipe(&err_read, &err_write, &inherit, 0)) { result.start_error = "pipes unavailable"; return result; }
    SetHandleInformation(in_write, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(err_read, HANDLE_FLAG_INHERIT, 0);
    std::wstring command = quote(widen(o.argv[0]));
    for (std::size_t i = 1; i < o.argv.size(); ++i) { command += L" " + (o.windows_verbatim ? widen(o.argv[i]) : quote(widen(o.argv[i]))); }
    // Environment: this process's, plus the extras.
    std::wstring block;
    if (wchar_t *env = GetEnvironmentStringsW()) {
        for (const wchar_t *p = env; *p; p += wcslen(p) + 1) {
            const std::wstring entry(p); bool replaced = false;
            for (const auto &[k, v] : o.extra_env) { const auto key = widen(k) + L"="; if (_wcsnicmp(entry.c_str(), key.c_str(), key.size()) == 0) { replaced = true; } }
            if (!replaced) { block += entry; block += L'\0'; }
        }
        FreeEnvironmentStringsW(env);
    }
    for (const auto &[k, v] : o.extra_env) { block += widen(k) + L"=" + widen(v); block += L'\0'; }
    block += L'\0';
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    if (job) { SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits); }
    STARTUPINFOW startup {}; startup.cb = sizeof startup; startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = in_read; startup.hStdOutput = out_write; startup.hStdError = err_write;
    PROCESS_INFORMATION process {};
    const auto cwd = widen(o.cwd);
    const BOOL started = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, block.data(), cwd.empty() ? nullptr : cwd.c_str(), &startup, &process);
    CloseHandle(in_read); CloseHandle(out_write); CloseHandle(err_write);
    if (!started) {
        result.start_error = "spawn failed (" + std::to_string(GetLastError()) + ")";
        CloseHandle(in_write); CloseHandle(out_read); CloseHandle(err_read); if (job) { CloseHandle(job); }
        return result;
    }
    if (job) { AssignProcessToJobObject(job, process.hProcess); }
    ResumeThread(process.hThread); CloseHandle(process.hThread);
    std::atomic<bool> over {false}, out_done {false}, err_done {false};
    std::thread writer([&] { DWORD n = 0; WriteFile(in_write, o.input.data(), static_cast<DWORD>(o.input.size()), &n, nullptr); CloseHandle(in_write); });
    std::thread out_reader([&] {
        char buffer[8192]; DWORD n = 0;
        while (ReadFile(out_read, buffer, sizeof buffer, &n, nullptr) && n > 0) { if (!over) { result.out.append(buffer, n); if (result.out.size() > o.output_limit) { result.out.resize(o.output_limit); over = true; } } }
        out_done = true;
    });
    std::thread err_reader([&] {
        char buffer[8192]; DWORD n = 0;
        while (ReadFile(err_read, buffer, sizeof buffer, &n, nullptr) && n > 0) { result.err.append(buffer, n); if (result.err.size() > o.output_limit) { result.err.resize(o.output_limit); } }
        err_done = true;
    });
    const auto deadline = Clock::now() + std::chrono::milliseconds(o.timeout_ms);
    bool stopped = false;
    for (;;) {
        const bool exited = WaitForSingleObject(process.hProcess, 50) == WAIT_OBJECT_0;
        if (exited && ((out_done && err_done) || stopped)) { break; }
        Result::Stop stop = Result::Stop::none;
        if (over) { stop = Result::Stop::too_much_output; }
        else if (o.cancelled && o.cancelled()) { stop = Result::Stop::cancelled; }
        else if (Clock::now() >= deadline) { stop = Result::Stop::timeout; }
        if (stop != Result::Stop::none) {
            if (result.stop == Result::Stop::none) { result.stop = stop; }
            if (job) { TerminateJobObject(job, 1); } else { TerminateProcess(process.hProcess, 1); }
            stopped = true;
        }
    }
    // A stopped tree may leave a pipe open in a process outside the job; stop waiting for it then.
    if (stopped) { CancelSynchronousIo(out_reader.native_handle()); CancelSynchronousIo(err_reader.native_handle()); CloseHandle(out_read); CloseHandle(err_read); out_read = err_read = nullptr; }
    writer.join(); out_reader.join(); err_reader.join();
    if (over && result.stop == Result::Stop::none) { result.stop = Result::Stop::too_much_output; }
    DWORD code = 0; GetExitCodeProcess(process.hProcess, &code);
    result.status = static_cast<int>(code);
    CloseHandle(process.hProcess); if (out_read) { CloseHandle(out_read); } if (err_read) { CloseHandle(err_read); } if (job) { CloseHandle(job); }
    return result;
}
#else
Result run(const Options &o) {
    Result result;
    int in[2], out[2], err[2], ready[2];
    if (pipe(in) || pipe(out) || pipe(err) || pipe(ready)) { result.start_error = std::strerror(errno); return result; }
    fcntl(ready[1], F_SETFD, FD_CLOEXEC);
    const pid_t pid = fork();
    if (pid < 0) { result.start_error = std::strerror(errno); return result; }
    if (pid == 0) {
        setpgid(0, 0); // its own process group, so a stop reaches everything it starts
        dup2(in[0], 0); dup2(out[1], 1); dup2(err[1], 2);
        close(in[0]); close(in[1]); close(out[0]); close(out[1]); close(err[0]); close(err[1]); close(ready[0]);
        std::signal(SIGPIPE, SIG_DFL);
        if (!o.cwd.empty() && chdir(o.cwd.c_str()) != 0) { const int e = errno; (void)!write(ready[1], &e, sizeof e); _exit(127); }
        for (const auto &[k, v] : o.extra_env) { setenv(k.c_str(), v.c_str(), 1); }
        std::vector<char *> argv; for (const auto &a : o.argv) { argv.push_back(const_cast<char *>(a.c_str())); } argv.push_back(nullptr);
        execvp(argv[0], argv.data());
        const int e = errno; (void)!write(ready[1], &e, sizeof e); _exit(127);
    }
    setpgid(pid, pid);
    close(in[0]); close(out[1]); close(err[1]); close(ready[1]);
    int start_errno = 0;
    if (read(ready[0], &start_errno, sizeof start_errno) == sizeof start_errno) {
        close(ready[0]); close(in[1]); close(out[0]); close(err[0]); waitpid(pid, nullptr, 0);
        result.start_error = std::strerror(start_errno); return result;
    }
    close(ready[0]);
    fcntl(in[1], F_SETFL, O_NONBLOCK);
    std::size_t written = 0;
    if (o.input.empty()) { close(in[1]); in[1] = -1; }
    const auto deadline = Clock::now() + std::chrono::milliseconds(o.timeout_ms);
    bool out_open = true, err_open = true, exited = false; int status = 0;
    const auto stop = [&](Result::Stop why) { if (result.stop == Result::Stop::none) { result.stop = why; } kill(-pid, SIGKILL); };
    while (out_open || err_open || !exited) {
        pollfd fds[3]; int n = 0;
        if (out_open) { fds[n++] = {out[0], POLLIN, 0}; }
        if (err_open) { fds[n++] = {err[0], POLLIN, 0}; }
        if (in[1] >= 0) { fds[n++] = {in[1], POLLOUT, 0}; }
        poll(fds, static_cast<nfds_t>(n), 50);
        for (int k = 0; k < n; ++k) {
            if (!fds[k].revents) { continue; }
            if (fds[k].fd == in[1]) {
                const auto w = write(in[1], o.input.data() + written, o.input.size() - written);
                if (w > 0) { written += static_cast<std::size_t>(w); }
                if (w < 0 && errno != EAGAIN) { written = o.input.size(); }
                if (written >= o.input.size()) { close(in[1]); in[1] = -1; }
                continue;
            }
            char buffer[8192];
            const auto r = read(fds[k].fd, buffer, sizeof buffer);
            if (r <= 0) { if (fds[k].fd == out[0]) { out_open = false; } else { err_open = false; } continue; }
            auto &target = fds[k].fd == out[0] ? result.out : result.err;
            target.append(buffer, static_cast<std::size_t>(r));
            if (target.size() > o.output_limit) { target.resize(o.output_limit); if (fds[k].fd == out[0]) { stop(Result::Stop::too_much_output); } }
        }
        if (!exited && waitpid(pid, &status, WNOHANG) == pid) { exited = true; }
        // As Node's "close": finished once it has exited and its outputs are closed. Background programs it started
        // may keep running (the app never stopped those); the time limit and cancelling still apply until then.
        if (out_open || err_open || !exited) {
            if (o.cancelled && o.cancelled()) { stop(Result::Stop::cancelled); }
            else if (Clock::now() >= deadline) { stop(Result::Stop::timeout); }
        }
        if (exited && result.stop != Result::Stop::none) { out_open = err_open = false; }
    }
    if (in[1] >= 0) { close(in[1]); }
    close(out[0]); close(err[0]);
    if (WIFEXITED(status)) { result.status = WEXITSTATUS(status); }
    return result;
}
#endif
}
