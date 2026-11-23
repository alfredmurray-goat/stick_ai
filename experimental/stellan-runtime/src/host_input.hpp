#pragma once
#include <array>
#include <chrono>
#include <functional>
#include <string>

namespace stellan {
class HostInput {
public:
    HostInput();
    bool read_line(std::string &line, const std::function<bool()> &cancelled);
    bool rested() const { return rested_; }
    unsigned idle_seconds() const { return idle_seconds_; }
private:
    std::array<char, 4096> buffer_ {};
    std::size_t first_ = 0, end_ = 0;
    unsigned idle_seconds_ = 600;
    bool rested_ = false;
};
}
