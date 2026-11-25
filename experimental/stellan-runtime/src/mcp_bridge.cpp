#include "mcp_bridge.hpp"

#include <stdexcept>
#include <string>
#include <vector>

#ifndef _WIN32
#include <cerrno>
#include <csignal>
#include <cstring>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace stellan {
#ifdef _WIN32
int mcp_bridge(int, char **) { throw std::runtime_error("The native MCP bridge is not available on Windows yet"); }
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
