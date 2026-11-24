#pragma once

#include "executor.hpp"
#include "runtime.hpp"

#include <cstdint>
#include <functional>
#include <span>
#include <utility>
#include <vector>

namespace stellan {
// "The eye": the Pixtral-style image encoder used by Mistral Small 3.1 and the Ministral 3 family
// (patch convolution, RMSNorm, 2D RoPE, gated-SiLU transformer), followed by Mistral 3's projector
// (RMSNorm, 2x2 patch merger, two-layer GELU MLP). It reads llama.cpp-style "clip" GGUF files with
// projector type "pixtral" (mmproj files), so trained projectors for Lite and Max drop in later.
class Eye {
public:
    Eye(const Model &model, unsigned threads);
    std::size_t patch() const { return patch_; }
    std::size_t merge() const { return merge_; }
    std::size_t width() const { return width_; }
    std::size_t output_width() const { return output_width_; }
    std::size_t layers() const { return layers_.size(); }
    std::size_t longest_edge() const { return longest_edge_; }
    bool has_break_token() const { return break_token_ != nullptr; }
    // Files converted before Mistral's 9 May 2025 config fix say "gelu"; the encoder is SiLU either way.
    bool stale_gelu_flag() const { return stale_gelu_; }
    // The size an image is resized to: within the longest edge, keeping its shape, with both sides a
    // whole number of merged patches (patch * merge pixels).
    std::pair<std::size_t, std::size_t> fit(std::size_t width, std::size_t height) const;
    // Resizes 8-bit RGB pixels (row-major, 3 bytes each) to `fit` with bilinear filtering and applies the
    // model's per-channel normalisation. Returns channel-major floats (3 x height x width).
    std::vector<float> prepare(std::span<const std::uint8_t> rgb, std::size_t width, std::size_t height, std::size_t &out_width, std::size_t &out_height) const;
    struct Result {
        std::size_t rows = 0;     // merged patch rows
        std::size_t columns = 0;  // merged patch columns
        std::vector<float> embeddings;  // rows * columns * output_width, row-major
        std::vector<float> break_embedding;  // [IMG_BREAK] text embedding when the file carries it
    };
    // Encodes channel-major normalised pixels whose sides are multiples of patch * merge.
    Result encode(std::span<const float> pixels, std::size_t width, std::size_t height, const std::function<bool()> &cancelled) const;
private:
    struct Layer {
        const Tensor *q, *k, *v, *out, *gate, *up, *down;
        std::vector<float> attention_norm, ffn_norm;
    };
    const Model &model_;
    mutable Executor executor_;
    std::size_t width_ = 0, heads_ = 0, head_width_ = 0, feed_forward_ = 0, patch_ = 0, merge_ = 1, longest_edge_ = 0, output_width_ = 0, hidden_width_ = 0;
    float epsilon_ = 1e-5F;
    bool stale_gelu_ = false;
    double rope_base_ = 10000;
    float mean_[3] = {0.48145466F, 0.4578275F, 0.40821073F};
    float deviation_[3] = {0.26862954F, 0.26130258F, 0.27577711F};
    const Tensor *patch_embedding_ = nullptr, *merger_ = nullptr, *projector_in_ = nullptr, *projector_out_ = nullptr, *break_token_ = nullptr;
    std::vector<float> pre_norm_, merger_norm_, projector_in_bias_, projector_out_bias_;
    std::vector<Layer> layers_;
    const Tensor *find(const std::string &name) const;
    const Tensor *matrix(const std::string &name, std::size_t columns, std::size_t rows) const;
    std::vector<float> floats(const std::string &name, std::size_t count) const;
    void linear(const Tensor *matrix, std::size_t columns, std::size_t rows, std::span<const float> input, std::size_t tokens, std::span<float> output, const std::function<bool()> &cancelled) const;
    void normalize(std::span<float> values, std::size_t tokens, std::span<const float> weights) const;
};
}
