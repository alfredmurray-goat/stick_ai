#pragma once
#include "runtime.hpp"
#include <array>

namespace stellan {
class KVCache {
public:
    KVCache() = default;
    KVCache(std::size_t context, std::size_t width, bool quantized);
    void write(std::size_t position, std::span<const float> values);
    float read(std::size_t position, std::size_t index) const;
    void decode(std::size_t position, std::size_t first, std::span<float> output) const;
    void clear();
    std::size_t bytes() const;
    std::size_t capacity_bytes() const;
private:
    struct Block { std::uint16_t scale; std::array<std::int8_t, 32> values; };
    static_assert(sizeof(Block) == 34);
    std::size_t context_ = 0, width_ = 0, positions_ = 0;
    bool quantized_ = false;
    std::vector<std::uint16_t> halves_;
    std::vector<Block> blocks_;
};
}
