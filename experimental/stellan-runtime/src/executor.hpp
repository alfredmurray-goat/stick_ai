#pragma once

#include <cstddef>
#include <functional>
#include <memory>

namespace stellan {
class Executor {
public:
    explicit Executor(unsigned threads);
    ~Executor();
    Executor(const Executor &) = delete;
    Executor &operator=(const Executor &) = delete;
    void parallel(std::size_t count, const std::function<void(std::size_t, std::size_t)> &function);
private:
    struct State;
    std::unique_ptr<State> state_;
};
}
