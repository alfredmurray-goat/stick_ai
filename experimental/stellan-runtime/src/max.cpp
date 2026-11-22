#include "max.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <stdexcept>

namespace stellan {
namespace {
std::size_t size(const Model &model, const std::string &key, std::size_t maximum) {
    const auto value = model.number("llama." + key);
    if (value < 1 || value > static_cast<double>(maximum) || value != std::floor(value)) {
        throw std::runtime_error("Unsupported transformer dimension: " + key);
    }
    return static_cast<std::size_t>(value);
}
}
const Tensor *Max::tensor(const std::string &name, const std::vector<std::uint64_t> &shape) const {
    const auto found = std::find_if(model_.tensors().begin(), model_.tensors().end(), [&](const auto &item) { return item.name == name; });
    if (found == model_.tensors().end() || found->dimensions != shape) { throw std::runtime_error("Missing or incompatible tensor: " + name); }
    if (found->type != 0 && found->type != 1 && found->type != 8 && found->type != 12 && found->type != 14) {
        throw std::runtime_error("Transformer matrix storage is not implemented");
    }
    return &*found;
}
std::vector<float> Max::floats(const Tensor *tensor) const {
    if (tensor->type != 0) { throw std::runtime_error("Transformer normalisation must be F32"); }
    std::vector<float> values(static_cast<std::size_t>(tensor->size / 4));
    decode_row(0, model_.data(*tensor), values);
    if (!std::all_of(values.begin(), values.end(), [](float value) { return std::isfinite(value); })) {
        throw std::runtime_error("Non-finite transformer parameters");
    }
    return values;
}
Max::Max(const Model &model, unsigned threads, std::size_t context) : model_(model), executor_(threads), context_(context) {
    if (model.architecture() != "llama") { throw std::runtime_error("Max requires the audited llama GGUF architecture"); }
    width_ = size(model, "embedding_length", 16384);
    heads_ = size(model, "attention.head_count", 256);
    kv_heads_ = size(model, "attention.head_count_kv", 256);
    head_width_ = size(model, "attention.key_length", 512);
    feed_forward_ = size(model, "feed_forward_length", 262144);
    const auto layers = size(model, "block_count", 256);
    if (model.tensors().size() != layers * 9 + 3 || model.has("llama.attention.sliding_window") || model.has("llama.rope.scaling.type") || model.has("llama.attention.logit_softcap") || model.has("llama.final_logit_softcap")) {
        throw std::runtime_error("Unsupported transformer variant or additional tensors");
    }
    const auto rope = size(model, "rope.dimension_count", 512);
    const auto value_width = size(model, "attention.value_length", 512);
    rope_base_ = model.number("llama.rope.freq_base");
    epsilon_ = static_cast<float>(model.number("llama.attention.layer_norm_rms_epsilon"));
    if (heads_ % kv_heads_ != 0 || rope != head_width_ || head_width_ % 2 != 0 || value_width != head_width_ ||
        context_ == 0 || context_ > 65536 ||
        rope_base_ <= 1 || epsilon_ <= 0 || epsilon_ > 0.1F || model.vocabulary().empty()) {
        throw std::runtime_error("Unsupported transformer configuration or KV memory budget");
    }
    const auto vocabulary = model.vocabulary().size();
    embedding_ = tensor("token_embd.weight", {width_, vocabulary});
    output_ = tensor("output.weight", {width_, vocabulary});
    final_norm_ = floats(tensor("output_norm.weight", {width_}));
    const auto query_width = heads_ * head_width_;
    quantized_cache_ = environment_set("STELLAN_RUNTIME_KV_Q8");
    const auto cache_budget = layers * 2 * KVCache(context_, kv_heads_ * head_width_, quantized_cache_).capacity_bytes();
    if (cache_budget > 8ULL * 1024 * 1024 * 1024) { throw std::runtime_error("Transformer KV capacity exceeds the 8 GiB experimental budget"); }
    const auto kv_width = kv_heads_ * head_width_;
    for (std::size_t i = 0; i < layers; ++i) {
        const auto prefix = "blk." + std::to_string(i) + ".";
        Layer layer;
        layer.q = tensor(prefix + "attn_q.weight", {width_, query_width});
        layer.k = tensor(prefix + "attn_k.weight", {width_, kv_width});
        layer.v = tensor(prefix + "attn_v.weight", {width_, kv_width});
        layer.out = tensor(prefix + "attn_output.weight", {query_width, width_});
        layer.gate = tensor(prefix + "ffn_gate.weight", {width_, feed_forward_});
        layer.up = tensor(prefix + "ffn_up.weight", {width_, feed_forward_});
        layer.down = tensor(prefix + "ffn_down.weight", {feed_forward_, width_});
        layer.attention_norm = floats(tensor(prefix + "attn_norm.weight", {width_}));
        layer.ffn_norm = floats(tensor(prefix + "ffn_norm.weight", {width_}));
        layer.keys = KVCache(context_, kv_width, quantized_cache_);
        layer.values = KVCache(context_, kv_width, quantized_cache_);
        layers_.push_back(std::move(layer));
    }
    hidden_.resize(width_);
    normalized_.resize(width_);
    query_.resize(query_width);
    key_.resize(kv_width);
    value_.resize(kv_width);
    attended_.resize(query_width);
    update_.resize(width_);
    gate_.resize(feed_forward_);
    up_.resize(feed_forward_);
    logits_.resize(vocabulary);
}
void Max::multiply(const Tensor *matrix, std::span<const float> input, std::span<float> output, const std::function<bool()> &cancelled) {
    const auto weights = model_.data(*matrix);
    const auto stride = row_bytes(matrix->type, input.size());
    const bool fast = (matrix->type == 12 || matrix->type == 14) && !environment_set("STELLAN_RUNTIME_PRECISE");
    const auto quantized = fast ? quantize_input(input) : std::vector<QuantizedInput> {};
    executor_.parallel(output.size(), [&](std::size_t first, std::size_t last) {
        for (auto row = first; row < last; ++row) {
            if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
            output[row] = fast ? quantized_dot(matrix->type, weights.subspan(row * stride, stride), quantized) : dot(matrix->type, weights.subspan(row * stride, stride), input);
        }
    });
}
void Max::normalize(std::span<const float> input, std::span<const float> weights, std::span<float> output) const {
    double sum = 0;
    for (const auto value : input) { sum += static_cast<double>(value) * value; }
    const auto scale = static_cast<float>(1 / std::sqrt(sum / static_cast<double>(input.size()) + epsilon_));
    for (std::size_t i = 0; i < input.size(); ++i) { output[i] = input[i] * scale * weights[i]; }
}
void Max::rotate(std::span<float> values, std::size_t heads) const {
    for (std::size_t h = 0; h < heads; ++h) {
        for (std::size_t i = 0; i < head_width_; i += 2) {
            const auto angle = static_cast<double>(position_) / std::pow(rope_base_, static_cast<double>(i) / static_cast<double>(head_width_));
            const auto c = static_cast<float>(std::cos(angle));
            const auto s = static_cast<float>(std::sin(angle));
            const auto index = h * head_width_ + i;
            const auto a = values[index];
            const auto b = values[index + 1];
            values[index] = a * c - b * s;
            values[index + 1] = a * s + b * c;
        }
    }
}
const std::vector<float> &Max::step(std::int32_t token, const std::function<bool()> &cancelled) {
    return evaluate(token, cancelled, true);
}
const std::vector<float> &Max::prefill(std::span<const std::int32_t> tokens, const std::function<bool()> &cancelled, const std::function<void(std::size_t)> &progress) {
    if (tokens.empty() || tokens.size() > context_ - position_ || !std::all_of(tokens.begin(), tokens.end(), [&](auto token) { return token >= 0 && static_cast<std::size_t>(token) < logits_.size(); })) {
        throw std::runtime_error("Invalid transformer prompt or context is full");
    }
    for (std::size_t i = 0; i < tokens.size(); ++i) {
        evaluate(tokens[i], cancelled, i + 1 == tokens.size());
        if (progress) { progress(i + 1); }
    }
    return logits_;
}
const std::vector<float> &Max::evaluate(std::int32_t token, const std::function<bool()> &cancelled, bool output_logits) {
    if (token < 0 || static_cast<std::size_t>(token) >= logits_.size() || position_ >= context_) {
        throw std::runtime_error("Invalid token or transformer context is full");
    }
    const auto stride = row_bytes(embedding_->type, width_);
    decode_row(embedding_->type, model_.data(*embedding_).subspan(static_cast<std::size_t>(token) * stride, stride), hidden_);
    for (auto &layer : layers_) {
        normalize(hidden_, layer.attention_norm, normalized_);
        multiply(layer.q, normalized_, query_, cancelled);
        multiply(layer.k, normalized_, key_, cancelled);
        multiply(layer.v, normalized_, value_, cancelled);
        rotate(query_, heads_);
        rotate(key_, kv_heads_);
        layer.keys.write(position_, key_);
        layer.values.write(position_, value_);
        executor_.parallel(heads_, [&](std::size_t first, std::size_t last) {
            std::vector<float> scores(position_ + 1), cached(head_width_);
            for (auto h = first; h < last; ++h) {
                if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
                const auto kv_head = h / (heads_ / kv_heads_);
                float maximum = -INFINITY;
                for (std::size_t t = 0; t <= position_; ++t) {
                    float score = 0;
                    layer.keys.decode(t, kv_head * head_width_, cached);
                    for (std::size_t i = 0; i < head_width_; ++i) { score += query_[h * head_width_ + i] * cached[i]; }
                    scores[t] = score / std::sqrt(static_cast<float>(head_width_));
                    maximum = std::max(maximum, scores[t]);
                }
                float denominator = 0;
                for (auto &score : scores) { score = std::exp(score - maximum); denominator += score; }
                for (auto &score : scores) { score /= denominator; }
                auto result = std::span(attended_).subspan(h * head_width_, head_width_);
                std::fill(result.begin(), result.end(), 0.0F);
                for (std::size_t t = 0; t <= position_; ++t) {
                    layer.values.decode(t, kv_head * head_width_, cached);
                    for (std::size_t i = 0; i < head_width_; ++i) { result[i] += scores[t] * cached[i]; }
                }
            }
        });
        multiply(layer.out, attended_, update_, cancelled);
        for (std::size_t i = 0; i < width_; ++i) { hidden_[i] += update_[i]; }
        normalize(hidden_, layer.ffn_norm, normalized_);
        multiply(layer.gate, normalized_, gate_, cancelled);
        multiply(layer.up, normalized_, up_, cancelled);
        for (std::size_t i = 0; i < feed_forward_; ++i) { gate_[i] = gate_[i] / (1 + std::exp(-gate_[i])) * up_[i]; }
        multiply(layer.down, gate_, update_, cancelled);
        for (std::size_t i = 0; i < width_; ++i) { hidden_[i] += update_[i]; }
    }
    if (output_logits) {
        normalize(hidden_, final_norm_, normalized_);
        multiply(output_, normalized_, logits_, cancelled);
        if (!std::all_of(logits_.begin(), logits_.end(), [](float value) { return std::isfinite(value); })) {
            throw std::runtime_error("Transformer produced non-finite logits");
        }
    }
    ++position_;
    return logits_;
}
void Max::reset() {
    position_ = 0;
    for (auto &layer : layers_) {
        layer.keys.clear(); layer.values.clear();
    }
}
std::size_t Max::state_bytes() const {
    std::size_t bytes = 0;
    for (const auto &layer : layers_) { bytes += layer.keys.bytes() + layer.values.bytes(); }
    return bytes;
}
std::size_t Max::state_capacity_bytes() const {
    std::size_t bytes = 0;
    for (const auto &layer : layers_) { bytes += layer.keys.capacity_bytes() + layer.values.capacity_bytes(); }
    return bytes;
}

}
