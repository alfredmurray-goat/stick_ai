#include "host_input.hpp"
#include <algorithm>
#include <cerrno>
#include <charconv>
#include <cstdlib>
#include <cstdint>
#include <stdexcept>
#include <string_view>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#include <thread>
#else
#include <poll.h>
#include <unistd.h>
#endif

namespace stellan {
HostInput::HostInput() {
#ifdef _WIN32
    char value[32];
    SetLastError(ERROR_SUCCESS);
    const auto length = GetEnvironmentVariableA("STELLAN_HOST_IDLE_SECONDS", value, static_cast<DWORD>(sizeof(value)));
    if (length == 0 && GetLastError() == ERROR_ENVVAR_NOT_FOUND) return;
    if (length == 0 || length >= sizeof(value)) throw std::runtime_error("Invalid host idle timeout");
    const std::string_view text(value, length);
#else
    const auto *value = std::getenv("STELLAN_HOST_IDLE_SECONDS");
    if (!value) return;
    const std::string_view text(value);
#endif
    unsigned seconds = 0;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), seconds);
    if (parsed.ec != std::errc() || parsed.ptr != text.data() + text.size() || seconds < 1 || seconds > 86400) throw std::runtime_error("Host idle timeout must be 1..86400 seconds");
    idle_seconds_ = seconds;
}

bool HostInput::read_line(std::string &line, const std::function<bool()> &cancelled) {
    using Clock = std::chrono::steady_clock;
    auto activity = Clock::now();
    auto request_start = Clock::time_point::max();
    if (line.capacity() > 65536) { std::string().swap(line); }
    else { line.clear(); }
    while (!cancelled()) {
        if (first_ < end_) {
            const auto begin = buffer_.begin() + static_cast<std::ptrdiff_t>(first_);
            const auto end = buffer_.begin() + static_cast<std::ptrdiff_t>(end_);
            const auto newline = std::find(begin, end, '\n');
            const auto count = static_cast<std::size_t>(newline - begin);
            if (count > 4194304 - line.size()) throw std::runtime_error("Host request exceeds limit");
            line.append(buffer_.data() + first_, count);
            first_ += count;
            if (newline != end) {
                ++first_;
                if (!line.empty() && line.back() == '\r') line.pop_back();
                return true;
            }
        }
        const auto deadline = request_start == Clock::time_point::max() ? activity : std::min(activity, request_start);
        const auto remaining = std::chrono::seconds(idle_seconds_) - (Clock::now() - deadline);
        if (remaining <= Clock::duration::zero() && !line.empty()) throw std::runtime_error("Host request did not finish within the input timeout");
        if (remaining <= Clock::duration::zero()) { rested_ = true; return false; }
#ifdef _WIN32
        const auto handle = GetStdHandle(STD_INPUT_HANDLE);
        const auto type = GetFileType(handle);
        DWORD available = static_cast<DWORD>(buffer_.size());
        if (type == FILE_TYPE_PIPE) {
            if (!PeekNamedPipe(handle, nullptr, 0, nullptr, &available, nullptr)) {
                if (GetLastError() == ERROR_BROKEN_PIPE) { if (!line.empty()) throw std::runtime_error("Incomplete host request"); return false; }
                throw std::runtime_error("Cannot inspect host input pipe");
            }
            if (available == 0) { std::this_thread::sleep_for(std::min(std::chrono::milliseconds(100), std::chrono::duration_cast<std::chrono::milliseconds>(remaining) + std::chrono::milliseconds(1))); continue; }
        } else if (type != FILE_TYPE_DISK) { throw std::runtime_error("Native host expects redirected stdin or a private pipe"); }
        DWORD count = 0;
        if (!ReadFile(handle, buffer_.data(), std::min<DWORD>(available, static_cast<DWORD>(buffer_.size())), &count, nullptr)) {
            if (GetLastError() != ERROR_BROKEN_PIPE) throw std::runtime_error("Cannot read host input");
            count = 0;
        }
#else
        pollfd input {STDIN_FILENO, POLLIN, 0};
        const auto timeout = static_cast<int>(std::min<std::int64_t>(1000, std::chrono::duration_cast<std::chrono::milliseconds>(remaining).count() + 1));
        const auto ready = poll(&input, 1, timeout);
        if (ready < 0) { if (errno == EINTR) continue; throw std::runtime_error("Cannot wait for host input"); }
        if (ready == 0) continue;
        if ((input.revents & (POLLERR | POLLNVAL)) != 0) throw std::runtime_error("Host input pipe failed");
        const auto count = read(STDIN_FILENO, buffer_.data(), buffer_.size());
        if (count < 0) { if (errno == EINTR) continue; throw std::runtime_error("Cannot read host input"); }
#endif
        if (count == 0) { if (!line.empty()) throw std::runtime_error("Incomplete host request"); return false; }
        first_ = 0; end_ = static_cast<std::size_t>(count); activity = Clock::now();
        if (request_start == Clock::time_point::max()) request_start = activity;
    }
    return false;
}
}
