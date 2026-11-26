#pragma once

#include "lite.hpp"
#include "kv_cache.hpp"

namespace stellan {
class Max : public Decoder {
public:
    Max(const Model &model, unsigned threads, std::size_t context);
    const std::vector<float> &step(std::int32_t token, const std::function<bool()> &cancelled) override;
    const std::vector<float> &prefill(std::span<const std::int32_t> tokens, const std::function<bool()> &cancelled, const std::function<void(std::size_t)> &progress = {}) override;
    void reset() override;
    std::size_t state_bytes() const override;
    std::size_t state_capacity_bytes() const override;
    std::string_view cache_type() const override { return quantized_cache_ ? "q8_0" : "f16"; }
private:
    struct Layer {
        const Tensor *q;
        const Tensor *k;
        const Tensor *v;
        const Tensor *out;
        const Tensor *gate;
        const Tensor *up;
        const Tensor *down;
        std::vector<float> attention_norm;
        std::vector<float> ffn_norm;
        KVCache keys;
        KVCache values;
    };
    const std::vector<float> &evaluate(std::int32_t token, const std::function<bool()> &cancelled, bool output_logits);
    const Model &model_;
    Executor executor_;
    std::size_t width_;
    std::size_t heads_;
    std::size_t kv_heads_;
    std::size_t head_width_;
    std::size_t feed_forward_;
    std::size_t context_;
    std::size_t position_ = 0;
    bool quantized_cache_ = false;
    float epsilon_;
    double rope_base_;
    const Tensor *embedding_;
    const Tensor *output_;
    std::vector<float> final_norm_;
    std::vector<Layer> layers_;
    std::vector<float> hidden_;
    std::vector<float> normalized_;
    std::vector<float> query_;
    std::vector<float> key_;
    std::vector<float> value_;
    std::vector<float> attended_;
    std::vector<float> update_;
    std::vector<float> gate_;
    std::vector<float> up_;
    std::vector<float> logits_;
    const Tensor *tensor(const std::string &name, const std::vector<std::uint64_t> &shape) const;
    std::vector<float> floats(const Tensor *tensor) const;
    void multiply(const Tensor *matrix, std::span<const float> input, std::span<float> output, const std::function<bool()> &cancelled);
    void normalize(std::span<const float> input, std::span<const float> weights, std::span<float> output) const;
    void rotate(std::span<float> values, std::size_t heads, std::size_t position) const;
    void multiply_batch(const Tensor *matrix, std::span<const float> input, std::span<float> output, std::size_t batch, const std::function<bool()> &cancelled);
    void attend(Layer &layer, std::span<const float> query, std::size_t position, std::span<float> output, const std::function<bool()> &cancelled);
    void prefill_batch(std::span<const std::int32_t> tokens, const std::function<bool()> &cancelled, bool output_logits);
    std::array<std::vector<QuantizedInput>, prefill_batch_limit> batch_quantized_;
    std::vector<float> batch_hidden_, batch_normalized_, batch_query_, batch_key_, batch_value_, batch_attended_, batch_update_, batch_gate_, batch_up_;
};
}
