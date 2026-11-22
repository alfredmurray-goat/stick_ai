#include "lite.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <numeric>
#include <stdexcept>

namespace stellan {
namespace {
std::size_t dimension(const Model &model, const std::string &key, std::size_t maximum) {
    const auto value = model.number("mamba2." + key);
    if (value < 1 || value > static_cast<double>(maximum) || std::floor(value) != value) {
        throw std::runtime_error("Unsupported Mamba2 dimension: " + key);
    }
    return static_cast<std::size_t>(value);
}
float silu(float value) { return value / (1 + std::exp(-value)); }
}

const Tensor *Lite::tensor(const std::string &name, const std::vector<std::uint64_t> &shape) const {
    const auto found = std::find_if(model_.tensors().begin(), model_.tensors().end(), [&](const auto &item) { return item.name == name; });
    if (found == model_.tensors().end() || found->dimensions != shape) { throw std::runtime_error("Missing or incompatible tensor: " + name); }
    return &*found;
}

std::vector<float> Lite::floats(const Tensor *tensor) const {
    if (tensor->type != 0) { throw std::runtime_error("Mamba2 auxiliary tensors must be F32"); }
    std::vector<float> result(static_cast<std::size_t>(tensor->size / 4));
    decode_row(0, model_.data(*tensor), result);
    if (!std::all_of(result.begin(), result.end(), [](float value) { return std::isfinite(value); })) {
        throw std::runtime_error("Non-finite Mamba2 parameters");
    }
    return result;
}

Lite::Lite(const Model &model, unsigned threads) : model_(model), executor_(threads) {
    if (model.architecture() != "mamba2") { throw std::runtime_error("This engine currently executes Mamba2 only"); }
    width_ = dimension(model, "embedding_length", 16384);
    inner_ = dimension(model, "ssm.inner_size", 65536);
    states_ = dimension(model, "ssm.state_size", 1024);
    heads_ = dimension(model, "ssm.time_step_rank", 1024);
    groups_ = dimension(model, "ssm.group_count", 1024);
    kernel_ = dimension(model, "ssm.conv_kernel", 64);
    const auto count = dimension(model, "block_count", 256);
    if (model.tensors().size() != count * 9 + 3) { throw std::runtime_error("Unsupported additional or missing Mamba2 tensors"); }
    epsilon_ = static_cast<float>(model.number("mamba2.attention.layer_norm_rms_epsilon"));
    if (inner_ % heads_ != 0 || heads_ % groups_ != 0 || kernel_ < 2 || epsilon_ <= 0 || epsilon_ > 0.1F ||
        count * inner_ * states_ > 268435456 || model.vocabulary().empty()) {
        throw std::runtime_error("Unsupported Mamba2 configuration or state budget");
    }
    const auto vocab = model.vocabulary().size();
    embedding_ = tensor("token_embd.weight", {width_, vocab});
    output_ = tensor("output.weight", {width_, vocab});
    norm_ = tensor("output_norm.weight", {width_});
    final_norm_ = floats(norm_);
    const auto conv = inner_ + 2 * groups_ * states_;
    if (count * conv * kernel_ * sizeof(float) * 2 > 1073741824) { throw std::runtime_error("Mamba2 auxiliary memory exceeds the prototype budget"); }
    for (std::size_t i = 0; i < count; ++i) {
        const auto prefix = "blk." + std::to_string(i) + ".";
        Layer layer;
        layer.norm = tensor(prefix + "attn_norm.weight", {width_});
        layer.norm_weight = floats(layer.norm);
        layer.projection = tensor(prefix + "ssm_in.weight", {width_, inner_ + conv + heads_});
        layer.output = tensor(prefix + "ssm_out.weight", {inner_, width_});
        layer.conv_weight = floats(tensor(prefix + "ssm_conv1d.weight", {kernel_, conv}));
        layer.conv_bias = floats(tensor(prefix + "ssm_conv1d.bias", {conv}));
        layer.dt_bias = floats(tensor(prefix + "ssm_dt.bias", {heads_}));
        layer.decay = floats(tensor(prefix + "ssm_a", {1, heads_}));
        layer.skip = floats(tensor(prefix + "ssm_d", {1, heads_}));
        layer.gated_norm = floats(tensor(prefix + "ssm_norm.weight", {inner_ / groups_, groups_}));
        layer.history.resize(conv * (kernel_ - 1));
        layer.state.resize(inner_ * states_);
        for (const auto *matrix : {layer.projection, layer.output, output_}) {
            if (matrix->type != 0 && matrix->type != 1 && matrix->type != 8 && matrix->type != 12 && matrix->type != 14) {
                throw std::runtime_error("Mamba2 matrix storage is not implemented");
            }
        }
        layers_.push_back(std::move(layer));
    }
    hidden_.resize(width_);
    normalized_.resize(width_);
    projection_.resize(inner_ + conv + heads_);
    convolution_.resize(conv);
    mixed_.resize(inner_);
    delta_.resize(heads_);
    update_.resize(width_);
    logits_.resize(vocab);
}

void Lite::multiply(const Tensor *matrix, std::span<const float> input, std::span<float> output, const std::function<bool()> &cancelled) {
    const auto data = model_.data(*matrix);
    const auto stride = row_bytes(matrix->type, input.size());
    const bool fast = (matrix->type == 12 || matrix->type == 14) && !environment_set("STELLAN_RUNTIME_PRECISE");
    const auto quantized = fast ? quantize_input(input) : std::vector<QuantizedInput> {};
    executor_.parallel(output.size(), [&](std::size_t first, std::size_t last) {
        for (auto row = first; row < last; ++row) {
            if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
            output[row] = fast ? quantized_dot(matrix->type, data.subspan(row * stride, stride), quantized) : dot(matrix->type, data.subspan(row * stride, stride), input);
        }
    });
}

void Lite::normalize(std::span<const float> input, std::span<const float> weights, std::span<float> output) const {
    double squares = 0;
    for (const auto value : input) { squares += static_cast<double>(value) * value; }
    const auto inverse = static_cast<float>(1 / std::sqrt(squares / static_cast<double>(input.size()) + epsilon_));
    for (std::size_t i = 0; i < input.size(); ++i) { output[i] = input[i] * inverse * weights[i]; }
}

const std::vector<float> &Lite::step(std::int32_t token, const std::function<bool()> &cancelled) {
    if (token < 0 || static_cast<std::size_t>(token) >= logits_.size()) { throw std::runtime_error("Invalid input token"); }
    const auto stride = row_bytes(embedding_->type, width_);
    decode_row(embedding_->type, model_.data(*embedding_).subspan(static_cast<std::size_t>(token) * stride, stride), hidden_);
    const auto conv = convolution_.size();
    for (auto &layer : layers_) {
        if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
        normalize(hidden_, layer.norm_weight, normalized_);
        multiply(layer.projection, normalized_, projection_, cancelled);
        for (std::size_t channel = 0; channel < conv; ++channel) {
            auto value = layer.conv_bias[channel];
            const auto history = channel * (kernel_ - 1);
            const auto weights = channel * kernel_;
            for (std::size_t j = 0; j < kernel_ - 1; ++j) { value += layer.history[history + j] * layer.conv_weight[weights + j]; }
            const auto current = projection_[inner_ + channel];
            value += current * layer.conv_weight[weights + kernel_ - 1];
            for (std::size_t j = 0; j < kernel_ - 2; ++j) { layer.history[history + j] = layer.history[history + j + 1]; }
            layer.history[history + kernel_ - 2] = current;
            convolution_[channel] = silu(value);
        }
        for (std::size_t h = 0; h < heads_; ++h) {
            const auto value = projection_[inner_ + conv + h] + layer.dt_bias[h];
            delta_[h] = value > 20 ? value : std::log1p(std::exp(value));
        }
        mamba2_step(heads_, inner_ / heads_, states_, groups_, std::span(convolution_).first(inner_), delta_,
            layer.decay, std::span(convolution_).subspan(inner_, groups_ * states_),
            std::span(convolution_).subspan(inner_ + groups_ * states_), layer.skip, layer.state, mixed_);
        for (std::size_t i = 0; i < inner_; ++i) { mixed_[i] *= silu(projection_[i]); }
        const auto group_width = inner_ / groups_;
        for (std::size_t g = 0; g < groups_; ++g) {
            const auto offset = g * group_width;
            auto values = std::span(mixed_).subspan(offset, group_width);
            normalize(values, std::span(layer.gated_norm).subspan(offset, group_width), values);
        }
        multiply(layer.output, mixed_, update_, cancelled);
        for (std::size_t i = 0; i < width_; ++i) { hidden_[i] += update_[i]; }
    }
    normalize(hidden_, final_norm_, normalized_);
    multiply(output_, normalized_, logits_, cancelled);
    if (!std::all_of(logits_.begin(), logits_.end(), [](float value) { return std::isfinite(value); })) {
        throw std::runtime_error("Model produced non-finite logits");
    }
    return logits_;
}

void Lite::reset() {
    for (auto &layer : layers_) {
        std::fill(layer.history.begin(), layer.history.end(), 0.0f);
        std::fill(layer.state.begin(), layer.state.end(), 0.0f);
    }
}
std::size_t Lite::state_bytes() const {
    std::size_t size = 0;
    for (const auto &layer : layers_) { size += (layer.history.size() + layer.state.size()) * sizeof(float); }
    return size;
}
}
