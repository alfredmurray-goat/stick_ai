#pragma once

#include "executor.hpp"
#include "runtime.hpp"

#include <atomic>
#include <unordered_map>

namespace stellan {
class Decoder {
public:
    virtual ~Decoder() = default;
    virtual const std::vector<float> &step(std::int32_t token, const std::function<bool()> &cancelled) = 0;
    virtual const std::vector<float> &prefill(std::span<const std::int32_t> tokens, const std::function<bool()> &cancelled, const std::function<void(std::size_t)> &progress = {});
    virtual void reset() = 0;
    virtual std::size_t state_bytes() const = 0;
    virtual std::size_t state_capacity_bytes() const { return state_bytes(); }
    virtual std::string_view cache_type() const { return "recurrent-f32"; }
};
class Tokenizer {
public:
    explicit Tokenizer(const Model &model);
    std::vector<std::int32_t> encode(const std::string &text, std::size_t token_limit = 32768) const;
    std::string decode(std::int32_t token) const;
    std::int32_t eos() const;
private:
    const Model &model_;
    std::unordered_map<std::string, std::int32_t> lookup_;
    std::vector<std::pair<std::string_view, std::int32_t>> specials_;
    std::unordered_map<unsigned, std::int32_t> bytes_;
    std::int32_t bos_;
    std::int32_t eos_;
    bool bpe_ = false;
    std::unordered_map<std::string, unsigned> byte_characters_;
    void ordinary(const std::string &text, std::vector<std::int32_t> &output, bool prefix) const;
};

class Lite : public Decoder {
public:
    Lite(const Model &model, unsigned threads);
    const std::vector<float> &step(std::int32_t token, const std::function<bool()> &cancelled) override;
    const std::vector<float> &prefill(std::span<const std::int32_t> tokens, const std::function<bool()> &cancelled, const std::function<void(std::size_t)> &progress = {}) override;
    void reset() override;
    std::size_t state_bytes() const override;
private:
    struct Layer {
        const Tensor *norm;
        const Tensor *projection;
        const Tensor *output;
        std::vector<float> conv_weight;
        std::vector<float> conv_bias;
        std::vector<float> dt_bias;
        std::vector<float> decay;
        std::vector<float> skip;
        std::vector<float> gated_norm;
        std::vector<float> norm_weight;
        std::vector<float> history;
        std::vector<float> state;
    };
    const Model &model_;
    Executor executor_;
    const Tensor *embedding_;
    const Tensor *output_;
    const Tensor *norm_;
    std::size_t width_;
    std::size_t inner_;
    std::size_t states_;
    std::size_t heads_;
    std::size_t groups_;
    std::size_t kernel_;
    float epsilon_;
    std::vector<Layer> layers_;
    std::vector<QuantizedInput> quantized_scratch_;
    std::array<std::vector<QuantizedInput>, prefill_batch_limit> batch_quantized_scratch_;
    std::vector<float> hidden_;
    std::vector<float> normalized_;
    std::vector<float> projection_;
    std::vector<float> convolution_;
    std::vector<float> mixed_;
    std::vector<float> delta_;
    std::vector<float> update_;
    std::vector<float> logits_;
    std::vector<float> final_norm_;
    std::vector<float> batch_hidden_, batch_normalized_, batch_projected_, batch_mixed_, batch_update_;
    const Tensor *tensor(const std::string &name, const std::vector<std::uint64_t> &shape) const;
    std::vector<float> floats(const Tensor *tensor) const;
    void multiply(const Tensor *tensor, std::span<const float> input, std::span<float> output, const std::function<bool()> &cancelled);
    void prepare_mix(Layer &layer, const std::function<bool()> &cancelled);
    void mix_batch(Layer &layer, std::size_t batch, const std::function<bool()> &cancelled);
    std::vector<float> batch_convolution_, batch_delta_, batch_attenuation_;
    void mix(Layer &layer, const std::function<bool()> &cancelled);
    void multiply_batch(const Tensor *tensor, std::span<const float> input, std::span<float> output, std::size_t batch, const std::function<bool()> &cancelled);
    void normalize(std::span<const float> input, std::span<const float> weights, std::span<float> output) const;
};
}
