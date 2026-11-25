#include "lite.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <numeric>
#include <stdexcept>

namespace stellan {
bool accelerated_ssm_tokens(std::size_t states, std::size_t tokens, const float *input, const float *dt, const float *attenuation, const float *const *b, const float *const *c, float skip, float *state, float *output);
bool accelerated_ssm(std::size_t width, std::size_t states, std::span<const float> input, float dt, float decay, float skip,
    std::span<const float> b, std::span<const float> c, std::span<float> state, std::span<float> output);
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

const std::vector<float> &Decoder::prefill(std::span<const std::int32_t> tokens, const std::function<bool()> &cancelled, const std::function<void(std::size_t)> &progress) {
    if (tokens.empty()) { throw std::runtime_error("A prompt token is required"); }
    const std::vector<float> *result = nullptr;
    for (std::size_t i = 0; i < tokens.size(); ++i) {
        result = &step(tokens[i], cancelled);
        if (progress) { progress(i + 1); }
    }
    return *result;
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
    // The copy is about the size of Lite's Q4_K weights; below 16 GiB the mapped file is kinder to the system.
    interleave_ = interleaved_q4k_available() && !environment_set("STELLAN_RUNTIME_PRECISE") &&
                  (environment_set("STELLAN_RUNTIME_INTERLEAVE") || ram_bytes() >= 16ULL * 1024 * 1024 * 1024);
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

const std::vector<std::byte> *Lite::interleaved(const Tensor *matrix, std::size_t rows, std::size_t stride) {
    if (!interleave_ || matrix->type != 12 || rows % 8 != 0 || stride % 144 != 0) { return nullptr; }
    if (const auto found = interleaved_.find(matrix); found != interleaved_.end()) { return &found->second; }
    const auto data = model_.data(*matrix);
    const auto group_bytes = stride / 144 * q4k_interleaved_block_bytes;
    std::vector<std::byte> packed(rows / 8 * group_bytes);
    executor_.parallel(rows / 8, [&](std::size_t first, std::size_t last) {
        for (auto g = first; g < last; ++g) { interleave_q4k(data.subspan(g * 8 * stride, 8 * stride), stride, std::span(packed).subspan(g * group_bytes, group_bytes)); }
    });
    return &interleaved_.emplace(matrix, std::move(packed)).first->second;
}

void Lite::multiply(const Tensor *matrix, std::span<const float> input, std::span<float> output, const std::function<bool()> &cancelled) {
    const auto data = model_.data(*matrix);
    const auto stride = row_bytes(matrix->type, input.size());
    const bool fast = (matrix->type == 12 || matrix->type == 14) && !environment_set("STELLAN_RUNTIME_PRECISE");
    if (fast) quantize_input(input, quantized_scratch_);
    const auto &quantized = quantized_scratch_;
    if (const auto *packed = fast ? interleaved(matrix, output.size(), stride) : nullptr) {
        const auto group_bytes = stride / 144 * q4k_interleaved_block_bytes;
        const std::span<const QuantizedInput> view(quantized);
        executor_.parallel(output.size() / 8, [&](std::size_t first, std::size_t last) {
            for (auto g = first; g < last; ++g) {
                if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
                interleaved_q4k_batch(std::span(*packed).subspan(g * group_bytes, group_bytes), std::span(&view, 1), output.data() + g * 8, 0);
            }
        });
        return;
    }
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
    for (auto &layer : layers_) {
        if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
        normalize(hidden_, layer.norm_weight, normalized_);
        multiply(layer.projection, normalized_, projection_, cancelled);
        mix(layer, cancelled);
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

void Lite::prepare_mix(Layer &layer, const std::function<bool()> &cancelled) {
    if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
    const auto conv = convolution_.size();
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
    for (std::size_t h = 0; h < heads_; ++h) {
        if (!std::isfinite(delta_[h]) || delta_[h] < 0 || !std::isfinite(layer.decay[h]) || layer.decay[h] > 0) { throw std::runtime_error("Invalid Mamba2 time step or decay"); }
    }
}

void Lite::mix(Layer &layer, const std::function<bool()> &cancelled) {
    prepare_mix(layer, cancelled);
    // Heads own disjoint state; splitting only by shared B/C groups can leave cores idle.
    executor_.parallel(heads_, [&](std::size_t first, std::size_t last) {
        const auto head_width = inner_ / heads_;
        for (auto head = first; head < last; ++head) {
            if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
            const auto group = head / (heads_ / groups_);
            const auto channel = head * head_width;
            mamba2_step(1, head_width, states_, 1,
                std::span(convolution_).subspan(channel, head_width), std::span(delta_).subspan(head, 1),
                std::span(layer.decay).subspan(head, 1), std::span(convolution_).subspan(inner_ + group * states_, states_),
                std::span(convolution_).subspan(inner_ + groups_ * states_ + group * states_, states_),
                std::span(layer.skip).subspan(head, 1), std::span(layer.state).subspan(channel * states_, head_width * states_),
                std::span(mixed_).subspan(channel, head_width));
        }
    });
    for (std::size_t i = 0; i < inner_; ++i) { mixed_[i] *= silu(projection_[i]); }
    const auto group_width = inner_ / groups_;
    for (std::size_t g = 0; g < groups_; ++g) {
        const auto offset = g * group_width;
        auto values = std::span(mixed_).subspan(offset, group_width);
        normalize(values, std::span(layer.gated_norm).subspan(offset, group_width), values);
    }
}

void Lite::mix_batch(Layer &layer, std::size_t batch, const std::function<bool()> &cancelled) {
    const auto conv = convolution_.size();
    batch_convolution_.resize(batch * conv);
    batch_delta_.resize(batch * heads_);
    batch_attenuation_.resize(batch * heads_);
    // The convolution remains causal. The large recurrent state is traversed channel first,
    // keeping each channel's state hot while processing all tokens in this microbatch.
    // The causal convolution is independent per channel, so channels are split across cores, each
    // walking the tokens in order: the same arithmetic as prepare_mix, token by token, so results are
    // bit-identical, but the work that ran on one core now runs on all of them.
    const auto width = projection_.size();
    executor_.parallel(conv, [&](std::size_t first, std::size_t last) {
        if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
        for (auto channel = first; channel < last; ++channel) {
            const auto history = channel * (kernel_ - 1);
            const auto weights = channel * kernel_;
            for (std::size_t t = 0; t < batch; ++t) {
                auto value = layer.conv_bias[channel];
                for (std::size_t j = 0; j < kernel_ - 1; ++j) { value += layer.history[history + j] * layer.conv_weight[weights + j]; }
                const auto current = batch_projected_[t * width + inner_ + channel];
                value += current * layer.conv_weight[weights + kernel_ - 1];
                for (std::size_t j = 0; j < kernel_ - 2; ++j) { layer.history[history + j] = layer.history[history + j + 1]; }
                layer.history[history + kernel_ - 2] = current;
                batch_convolution_[t * conv + channel] = silu(value);
            }
        }
    });
    for (std::size_t t = 0; t < batch; ++t) {
        for (std::size_t h = 0; h < heads_; ++h) {
            const auto value = batch_projected_[t * width + inner_ + conv + h] + layer.dt_bias[h];
            const auto delta = value > 20 ? value : std::log1p(std::exp(value));
            if (!std::isfinite(delta) || delta < 0 || !std::isfinite(layer.decay[h]) || layer.decay[h] > 0) { throw std::runtime_error("Invalid Mamba2 time step or decay"); }
            batch_delta_[t * heads_ + h] = delta;
            batch_attenuation_[t * heads_ + h] = std::exp(delta * layer.decay[h]);
        }
    }
    // Leave the single-token buffers as the token-by-token path would (the last token's values).
    {
        const auto last = batch - 1;
        std::copy_n(batch_projected_.begin() + static_cast<std::ptrdiff_t>(last * width), width, projection_.begin());
        std::copy_n(batch_convolution_.begin() + static_cast<std::ptrdiff_t>(last * conv), conv, convolution_.begin());
        std::copy_n(batch_delta_.begin() + static_cast<std::ptrdiff_t>(last * heads_), heads_, delta_.begin());
    }
    // Per-token B and C rows for each group, gathered once and shared by every channel of the group.
    std::array<std::array<const float *, prefill_batch_limit>, 64> b_rows {}, c_rows {};
    const bool grouped = groups_ <= b_rows.size();
    if (grouped) {
        for (std::size_t g = 0; g < groups_; ++g) {
            for (std::size_t t = 0; t < batch; ++t) {
                b_rows[g][t] = batch_convolution_.data() + t * conv + inner_ + g * states_;
                c_rows[g][t] = batch_convolution_.data() + t * conv + inner_ + groups_ * states_ + g * states_;
            }
        }
    }
    executor_.parallel(inner_, [&](std::size_t first, std::size_t last) {
        std::array<float, prefill_batch_limit> inputs {}, deltas {}, attenuations {}, outputs {};
        for (auto channel = first; channel < last; ++channel) {
            if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
            const auto head = channel / (inner_ / heads_);
            const auto group = head / (heads_ / groups_);
            auto state = std::span(layer.state).subspan(channel * states_, states_);
            if (grouped) {
                for (std::size_t t = 0; t < batch; ++t) {
                    inputs[t] = batch_convolution_[t * conv + channel];
                    deltas[t] = batch_delta_[t * heads_ + head];
                    attenuations[t] = batch_attenuation_[t * heads_ + head];
                }
                if (accelerated_ssm_tokens(states_, batch, inputs.data(), deltas.data(), attenuations.data(), b_rows[group].data(), c_rows[group].data(), layer.skip[head], state.data(), outputs.data())) {
                    for (std::size_t t = 0; t < batch; ++t) { batch_mixed_[t * inner_ + channel] = outputs[t]; }
                    continue;
                }
            }
            for (std::size_t t = 0; t < batch; ++t) {
                const auto values = std::span(batch_convolution_).subspan(t * conv, conv);
                const auto b = values.subspan(inner_ + group * states_, states_);
                const auto c = values.subspan(inner_ + groups_ * states_ + group * states_, states_);
                const auto dt = batch_delta_[t * heads_ + head];
                const auto attenuation = batch_attenuation_[t * heads_ + head];
                auto output = std::span(batch_mixed_).subspan(t * inner_ + channel, 1);
                if (!accelerated_ssm(1, states_, values.subspan(channel, 1), dt, attenuation, layer.skip[head], b, c, state, output)) {
                    float y = layer.skip[head] * values[channel];
                    for (std::size_t n = 0; n < states_; ++n) {
                        state[n] = attenuation * state[n] + dt * b[n] * values[channel];
                        y += c[n] * state[n];
                    }
                    output[0] = y;
                }
            }
        }
    });
    // Gate and group norm are per token: shared across cores, same arithmetic.
    executor_.parallel(batch, [&](std::size_t first_token, std::size_t last_token) {
    for (auto t = first_token; t < last_token; ++t) {
        auto mixed = std::span(batch_mixed_).subspan(t * inner_, inner_);
        const auto projected = std::span(batch_projected_).subspan(t * projection_.size(), inner_);
        for (std::size_t i = 0; i < inner_; ++i) { mixed[i] *= silu(projected[i]); }
        const auto group_width = inner_ / groups_;
        for (std::size_t g = 0; g < groups_; ++g) {
            auto group = mixed.subspan(g * group_width, group_width);
            normalize(group, std::span(layer.gated_norm).subspan(g * group_width, group_width), group);
        }
    }
    });
}

void Lite::multiply_batch(const Tensor *matrix, std::span<const float> input, std::span<float> output, std::size_t batch, const std::function<bool()> &cancelled) {
    const auto columns = static_cast<std::size_t>(matrix->dimensions[0]);
    const auto rows = static_cast<std::size_t>(matrix->dimensions[1]);
    if (batch == 0 || batch > prefill_batch_limit || input.size() != batch * columns || output.size() != batch * rows) { throw std::runtime_error("Invalid prefill matrix dimensions"); }
    const auto data = model_.data(*matrix);
    const auto stride = row_bytes(matrix->type, columns);
    const bool fast = (matrix->type == 12 || matrix->type == 14) && !environment_set("STELLAN_RUNTIME_PRECISE");
    auto &quantized = batch_quantized_scratch_;
    std::array<std::span<const QuantizedInput>, prefill_batch_limit> views;
    if (fast) {
        // Each token is quantised on its own, so tokens are shared across cores (same results).
        executor_.parallel(batch, [&](std::size_t first, std::size_t last) {
            for (auto t = first; t < last; ++t) { quantize_input(input.subspan(t * columns, columns), quantized[t]); }
        });
        for (std::size_t t = 0; t < batch; ++t) { views[t] = quantized[t]; }
        if (const auto *packed = interleaved(matrix, rows, stride)) {
            const auto group_bytes = stride / 144 * q4k_interleaved_block_bytes;
            executor_.parallel(rows / 8, [&](std::size_t first, std::size_t last) {
                for (auto g = first; g < last; ++g) {
                    if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
                    interleaved_q4k_batch(std::span(*packed).subspan(g * group_bytes, group_bytes), std::span(views).first(batch), output.data() + g * 8, rows);
                }
            });
            return;
        }
    }
    executor_.parallel(rows, [&](std::size_t first, std::size_t last) {
        std::array<float, prefill_batch_limit> values;
        for (auto row = first; row < last; ++row) {
            if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
            const auto weights = data.subspan(row * stride, stride);
            if (fast) {
                quantized_batch_dot(matrix->type, weights, std::span(views).first(batch), std::span(values).first(batch));
                for (std::size_t t = 0; t < batch; ++t) { output[t * rows + row] = values[t]; }
            } else {
                for (std::size_t t = 0; t < batch; ++t) { output[t * rows + row] = dot(matrix->type, weights, input.subspan(t * columns, columns)); }
            }
        }
    });
}

const std::vector<float> &Lite::prefill(std::span<const std::int32_t> tokens, const std::function<bool()> &cancelled, const std::function<void(std::size_t)> &progress) {
    // Keep prefill scratch across layers/chunks, then return it before interactive decoding.
    struct ReleaseScratch {
        std::array<std::vector<QuantizedInput>, prefill_batch_limit> &buffers;
        ~ReleaseScratch() { for (auto &buffer : buffers) std::vector<QuantizedInput>().swap(buffer); }
    } release {batch_quantized_scratch_};
    if (tokens.empty()) { throw std::runtime_error("A prompt token is required"); }
    for (const auto token : tokens) {
        if (token < 0 || static_cast<std::size_t>(token) >= logits_.size()) { throw std::runtime_error("Invalid input token"); }
    }
    const auto stride = row_bytes(embedding_->type, width_);
    // Every batch streams all the weights once, so split evenly (130 tokens: 5 x 26, not 4 x 32 + 2): a tiny
    // last batch would pay a whole pass over the weights for almost no work. Per-token results are unchanged.
    const auto passes = (tokens.size() + prefill_batch_limit - 1) / prefill_batch_limit;
    for (std::size_t offset = 0, pass = 0; offset < tokens.size(); ++pass) {
        const auto remaining = tokens.size() - offset;
        const auto batch = (remaining + (passes - pass) - 1) / (passes - pass);
        batch_hidden_.resize(batch * width_); batch_normalized_.resize(batch * width_);
        batch_projected_.resize(batch * projection_.size()); batch_mixed_.resize(batch * inner_); batch_update_.resize(batch * width_);
        for (std::size_t t = 0; t < batch; ++t) {
            decode_row(embedding_->type, model_.data(*embedding_).subspan(static_cast<std::size_t>(tokens[offset + t]) * stride, stride), std::span(batch_hidden_).subspan(t * width_, width_));
        }
        for (auto &layer : layers_) {
            if (cancelled()) { throw std::runtime_error("Generation cancelled"); }
            for (std::size_t t = 0; t < batch; ++t) { normalize(std::span(batch_hidden_).subspan(t * width_, width_), layer.norm_weight, std::span(batch_normalized_).subspan(t * width_, width_)); }
            multiply_batch(layer.projection, batch_normalized_, batch_projected_, batch, cancelled);
            mix_batch(layer, batch, cancelled);
            multiply_batch(layer.output, batch_mixed_, batch_update_, batch, cancelled);
            for (std::size_t i = 0; i < batch_hidden_.size(); ++i) { batch_hidden_[i] += batch_update_[i]; }
        }
        const auto last = std::span(batch_hidden_).subspan((batch - 1) * width_, width_);
        std::copy(last.begin(), last.end(), hidden_.begin());
        if (progress) { progress(offset + batch); }
        offset += batch;
    }
    normalize(hidden_, final_norm_, normalized_);
    multiply(output_, normalized_, logits_, cancelled);
    if (!std::all_of(logits_.begin(), logits_.end(), [](float value) { return std::isfinite(value); })) { throw std::runtime_error("Model produced non-finite logits"); }
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
