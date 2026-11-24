#include "executor.hpp"

#include <condition_variable>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace stellan {
struct Executor::State {
    unsigned threads;
    std::mutex submit;
    std::mutex mutex;
    std::condition_variable ready;
    std::condition_variable done;
    bool stop = false;
    std::size_t epoch = 0;
    std::size_t count = 0;
    unsigned pending = 0;
    std::function<void(std::size_t, std::size_t)> function;
    std::exception_ptr error;
    std::vector<std::thread> workers;

    explicit State(unsigned n) : threads(n) {
        if (n == 0 || n > 64) { throw std::runtime_error("Thread count must be between 1 and 64"); }
        try {
            for (unsigned i = 1; i < n; ++i) {
                workers.emplace_back([this, i] {
                    std::size_t seen = 0;
                    std::unique_lock lock(mutex);
                    while (true) {
                        ready.wait(lock, [&] { return stop || epoch != seen; });
                        if (stop) { return; }
                        seen = epoch;
                        const auto first = count * i / threads;
                        const auto last = count * (i + 1) / threads;
                        lock.unlock();
                        std::exception_ptr failure;
                        try { function(first, last); } catch (...) { failure = std::current_exception(); }
                        lock.lock();
                        if (failure && !error) { error = failure; }
                        if (--pending == 0) { done.notify_one(); }
                    }
                });
            }
        } catch (...) {
            shutdown();
            throw;
        }
    }
    void shutdown() {
        {
            std::lock_guard lock(mutex);
            stop = true;
        }
        ready.notify_all();
        for (auto &worker : workers) { if (worker.joinable()) { worker.join(); } }
    }
    ~State() { shutdown(); }
};

Executor::Executor(unsigned threads) : state_(std::make_unique<State>(threads)) {}
Executor::~Executor() = default;
void Executor::parallel(std::size_t count, const std::function<void(std::size_t, std::size_t)> &function) {
    auto &s = *state_;
    std::lock_guard submit(s.submit);
    // Avoid waking sleeping workers for serial or empty/single-row work.
    if (s.threads == 1 || count <= 1) { function(0, count); return; }
    {
        std::lock_guard lock(s.mutex);
        s.function = function;
        s.count = count;
        s.pending = s.threads - 1;
        s.error = nullptr;
        ++s.epoch;
    }
    s.ready.notify_all();
    std::exception_ptr failure;
    try { function(0, count / s.threads); } catch (...) { failure = std::current_exception(); }
    std::unique_lock lock(s.mutex);
    s.done.wait(lock, [&] { return s.pending == 0; });
    if (failure) { s.error = failure; }
    s.function = {};
    if (s.error) { std::rethrow_exception(s.error); }
}
}
