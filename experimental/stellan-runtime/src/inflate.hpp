#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <cstdio>
#endif

namespace stellan::inflate {
/** Streaming gzip decoder (one member, nothing after it): feed compressed bytes, get decoded bytes in order. */
class Decoder {
public:
    struct State;
    Decoder();
    ~Decoder();
    void set_limit(std::uint64_t bytes) { limit_ = bytes; }
    void feed(const std::uint8_t *data, std::size_t size, const std::function<void(const std::uint8_t *, std::size_t)> &sink);
    bool finished() const;
private:
    void emit(std::uint8_t byte);
    enum class Stage { header, block, trailer, done } stage_ = Stage::header;
    std::uint64_t limit_ = ~0ULL;
    std::unique_ptr<State> state_;
};
int gunzip_check();
}
