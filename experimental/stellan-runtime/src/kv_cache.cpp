#include "kv_cache.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace stellan {
KVCache::KVCache(std::size_t context, std::size_t width, bool quantized) : context_(context), width_(width), quantized_(quantized) {
    if (!context || context > 65536 || !width || width > 65536) throw std::runtime_error("Invalid KV cache dimensions");
}
void KVCache::write(std::size_t position, std::span<const float> values) {
    if (position >= context_ || values.size() != width_ || !std::all_of(values.begin(), values.end(), [](float value) { return std::isfinite(value); })) throw std::runtime_error("Invalid KV cache write");
    const auto per_token = (width_ + 31) / 32;
    const auto required = std::min(context_, ((position / 256) + 1) * 256);
    if (quantized_) {
        if (blocks_.size() < required * per_token) {
            std::vector<Block> grown(required * per_token);
            std::copy(blocks_.begin(), blocks_.end(), grown.begin()); blocks_.swap(grown);
        }
        for (std::size_t block = 0; block < per_token; ++block) {
            const auto count = std::min<std::size_t>(32, width_ - block * 32);
            const auto input = values.subspan(block * 32, count);
            float maximum = 0;
            for (const auto value : input) maximum = std::max(maximum, std::abs(value));
            const auto encoded = to_half(maximum / 127);
            const auto scale = maximum == 0 ? std::uint16_t {0} : std::max<std::uint16_t>(encoded, 1);
            const auto decoded = half(scale);
            if (!std::isfinite(decoded)) throw std::runtime_error("KV scale exceeds FP16 range");
            auto &output = blocks_[position * per_token + block];
            output.scale = scale; output.values.fill(0);
            for (std::size_t i = 0; i < input.size(); ++i) output.values[i] = decoded == 0 ? std::int8_t {0} : static_cast<std::int8_t>(std::clamp(std::nearbyint(input[i] / decoded), -127.0F, 127.0F));
        }
    } else {
        if (halves_.size() < required * width_) {
            std::vector<std::uint16_t> grown(required * width_);
            std::copy(halves_.begin(), halves_.end(), grown.begin()); halves_.swap(grown);
        }
        for (std::size_t i = 0; i < width_; ++i) halves_[position * width_ + i] = to_half(values[i]);
    }
    positions_ = std::max(positions_, position + 1);
}
float KVCache::read(std::size_t position, std::size_t index) const {
    if (position >= positions_ || index >= width_) throw std::runtime_error("Invalid KV cache read");
    if (!quantized_) return half(halves_[position * width_ + index]);
    const auto &block = blocks_[position * ((width_ + 31) / 32) + index / 32];
    return half(block.scale) * block.values[index % 32];
}
void KVCache::decode(std::size_t position, std::size_t first, std::span<float> output) const {
    if (position >= positions_ || first > width_ || output.size() > width_ - first) throw std::runtime_error("Invalid KV row read");
    if (!quantized_) {
        decode_row(1, std::as_bytes(std::span(halves_).subspan(position * width_ + first, output.size())), output);
        return;
    }
    std::size_t i = 0;
    for (; i < output.size(); ) {
        const auto index = first + i;
        if (index % 32 == 0 && output.size() - i >= 32) {
            const auto &block = blocks_[position * ((width_ + 31) / 32) + index / 32];
            decode_row(8, std::as_bytes(std::span(&block, 1)), output.subspan(i, 32));
            i += 32;
        } else { output[i] = read(position, index); ++i; }
    }
}
void KVCache::clear() { positions_ = 0; std::vector<std::uint16_t>().swap(halves_); std::vector<Block>().swap(blocks_); }
std::size_t KVCache::bytes() const { return halves_.capacity() * sizeof(std::uint16_t) + blocks_.capacity() * sizeof(Block); }
std::size_t KVCache::capacity_bytes() const { return quantized_ ? context_ * ((width_ + 31) / 32) * sizeof(Block) : context_ * width_ * sizeof(std::uint16_t); }
}
