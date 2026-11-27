#pragma once
#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace stellan::process {
struct Options {
    std::vector<std::string> argv;                              // program and arguments (UTF-8)
    std::string cwd;
    std::vector<std::pair<std::string, std::string>> extra_env; // added to this process's environment
    std::string input;                                          // written to standard input, then closed
    int timeout_ms = 30000;
    std::size_t output_limit = 65536;                           // standard output beyond this stops the program
    std::function<bool()> cancelled;
    bool windows_verbatim = false;                              // cmd.exe: pass arguments exactly as given
};
struct Result {
    enum class Stop { none, timeout, too_much_output, cancelled } stop = Stop::none;
    std::optional<int> status; // exit code; empty when ended by a signal
    std::string out, err;
    std::string start_error;   // set when the program could not be started
};
/** Runs a program in its own process group (a job object on Windows); any stop ends its whole process tree. */
Result run(const Options &options);
}
