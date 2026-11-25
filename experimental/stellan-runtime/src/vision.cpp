#include "vision.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <string>

namespace stellan {
bool accelerated_attention(std::size_t tokens, std::size_t dim, std::size_t stride, const float *q, const float *keys, const float *values, float scale, float *scores, float *out);
namespace {
std::size_t whole(const Model &model, const std::string &key, std::size_t maximum) {
    const auto value = model.number(key);
    if (value < 1 || value > static_cast<double>(maximum) || value != std::floor(value)) { throw std::runtime_error("Unsupported image encoder setting: " + key); }
    return static_cast<std::size_t>(value);
}
// Eight independent sums so the compiler can vectorise without reordering a single running sum.
float dot_floats(const float *a, const float *b, std::size_t count) {
    float lanes[8] = {};
    std::size_t i = 0;
    for (; i + 8 <= count; i += 8) {
        for (std::size_t j = 0; j < 8; ++j) { lanes[j] += a[i + j] * b[i + j]; }
    }
    float sum = 0;
    for (; i < count; ++i) { sum += a[i] * b[i]; }
    for (const auto lane : lanes) { sum += lane; }
    return sum;
}
}

const Tensor *Eye::find(const std::string &name) const {
    const auto found = std::find_if(model_.tensors().begin(), model_.tensors().end(), [&](const auto &item) { return item.name == name; });
    return found == model_.tensors().end() ? nullptr : &*found;
}
const Tensor *Eye::matrix(const std::string &name, std::size_t columns, std::size_t rows) const {
    const auto *tensor = find(name);
    if (tensor == nullptr || tensor->dimensions != std::vector<std::uint64_t> {columns, rows}) { throw std::runtime_error("Missing or incompatible image encoder tensor: " + name); }
    if (tensor->type != 0 && tensor->type != 1 && tensor->type != 8 && tensor->type != 12 && tensor->type != 14) { throw std::runtime_error("Image encoder matrix storage is not implemented: " + name); }
    return tensor;
}
std::vector<float> Eye::floats(const std::string &name, std::size_t count) const {
    const auto *tensor = find(name);
    if (tensor == nullptr || tensor->dimensions != std::vector<std::uint64_t> {count} || (tensor->type != 0 && tensor->type != 1)) { throw std::runtime_error("Missing or incompatible image encoder vector: " + name); }
    std::vector<float> values(count);
    decode_row(tensor->type, model_.data(*tensor), values);
    if (!std::all_of(values.begin(), values.end(), [](float value) { return std::isfinite(value); })) { throw std::runtime_error("Non-finite image encoder parameters"); }
    return values;
}

Eye::Eye(const Model &model, unsigned threads) : model_(model), executor_(threads) {
    if (model.architecture() != "clip" || !model.has("clip.projector_type") || model.text("clip.projector_type") != "pixtral") {
        throw std::runtime_error("The image encoder needs a Pixtral-type clip GGUF (Mistral Small 3.1 / Ministral 3 mmproj)");
    }
    width_ = whole(model, "clip.vision.embedding_length", 8192);
    heads_ = whole(model, "clip.vision.attention.head_count", 256);
    feed_forward_ = whole(model, "clip.vision.feed_forward_length", 65536);
    patch_ = whole(model, "clip.vision.patch_size", 64);
    longest_edge_ = whole(model, "clip.vision.image_size", 4096);
    const auto layers = whole(model, "clip.vision.block_count", 128);
    if (model.has("clip.vision.spatial_merge_size")) { merge_ = whole(model, "clip.vision.spatial_merge_size", 8); }
    if (model.has("clip.vision.attention.layer_norm_epsilon")) { epsilon_ = static_cast<float>(model.number("clip.vision.attention.layer_norm_epsilon")); }
    for (const auto *key : {"clip.vision.rope.freq_base", "clip.rope.freq_base"}) { if (model.has(key)) { rope_base_ = model.number(key); break; } }
    for (std::size_t c = 0; c < 3; ++c) {
        const auto index = std::to_string(c);
        if (model.has("clip.vision.image_mean")) { mean_[c] = static_cast<float>(model.number("clip.vision.image_mean." + index)); }
        if (model.has("clip.vision.image_std")) { deviation_[c] = static_cast<float>(model.number("clip.vision.image_std." + index)); }
        if (!std::isfinite(mean_[c]) || !(deviation_[c] > 0)) { throw std::runtime_error("Invalid image normalisation"); }
    }
    if (width_ % heads_ != 0 || (width_ / heads_) % 4 != 0 || !(epsilon_ > 0 && epsilon_ < 0.1F) || !(rope_base_ > 1) || longest_edge_ % (patch_ * merge_) != 0) {
        throw std::runtime_error("Unsupported image encoder configuration");
    }
    head_width_ = width_ / heads_;
    // Mistral's original Hugging Face config said the encoder MLP used GELU; on 9 May 2025 Mistral corrected
    // it to SiLU, which is what Mistral's reference code runs. Older mmproj files still carry the GELU flag.
    stale_gelu_ = model.has("clip.use_gelu") && model.number("clip.use_gelu") != 0;
    const auto *patch = find("v.patch_embd.weight");
    if (patch == nullptr || patch->dimensions != std::vector<std::uint64_t> {patch_, patch_, 3, width_} || (patch->type != 0 && patch->type != 1)) {
        throw std::runtime_error("Missing or incompatible image patch embedding");
    }
    if (find("v.patch_embd.bias") != nullptr || find("v.post_ln.weight") != nullptr || find("v.position_embd.weight") != nullptr) { throw std::runtime_error("Unsupported image encoder variant"); }
    patch_embedding_ = patch;
    pre_norm_ = floats("v.pre_ln.weight", width_);
    for (std::size_t i = 0; i < layers; ++i) {
        const auto prefix = "v.blk." + std::to_string(i) + ".";
        layers_.push_back(Layer {
            matrix(prefix + "attn_q.weight", width_, width_), matrix(prefix + "attn_k.weight", width_, width_),
            matrix(prefix + "attn_v.weight", width_, width_), matrix(prefix + "attn_out.weight", width_, width_),
            matrix(prefix + "ffn_gate.weight", width_, feed_forward_), matrix(prefix + "ffn_up.weight", width_, feed_forward_),
            matrix(prefix + "ffn_down.weight", feed_forward_, width_),
            floats(prefix + "ln1.weight", width_), floats(prefix + "ln2.weight", width_)});
    }
    if (merge_ > 1) {
        merger_norm_ = floats("mm.input_norm.weight", width_);
        merger_ = matrix("mm.patch_merger.weight", width_ * merge_ * merge_, width_);
    }
    const auto *first = find("mm.1.weight");
    if (first == nullptr || first->dimensions.size() != 2 || first->dimensions[0] != width_) { throw std::runtime_error("Missing image projector"); }
    hidden_width_ = static_cast<std::size_t>(first->dimensions[1]);
    projector_in_ = matrix("mm.1.weight", width_, hidden_width_);
    const auto *second = find("mm.2.weight");
    if (second == nullptr || second->dimensions.size() != 2) { throw std::runtime_error("Missing image projector output"); }
    output_width_ = static_cast<std::size_t>(second->dimensions[1]);
    if (hidden_width_ == 0 || hidden_width_ > 65536 || output_width_ == 0 || output_width_ > 65536) { throw std::runtime_error("Unsupported image projector size"); }
    projector_out_ = matrix("mm.2.weight", hidden_width_, output_width_);
    if (find("mm.1.bias") != nullptr) { projector_in_bias_ = floats("mm.1.bias", hidden_width_); }
    if (find("mm.2.bias") != nullptr) { projector_out_bias_ = floats("mm.2.bias", output_width_); }
    break_token_ = find("v.token_embd.img_break");
    if (break_token_ != nullptr && (break_token_->dimensions != std::vector<std::uint64_t> {output_width_} || (break_token_->type != 0 && break_token_->type != 1))) {
        throw std::runtime_error("Incompatible [IMG_BREAK] embedding");
    }
}

std::pair<std::size_t, std::size_t> Eye::fit(std::size_t width, std::size_t height) const {
    if (width == 0 || height == 0 || width > 65535 || height > 65535) { throw std::runtime_error("Image size is outside supported limits"); }
    // As Mistral's Pixtral processor: shrink (never enlarge) to fit the longest edge, then round each
    // side up to whole patches, here whole merged patches so the 2x2 merger has complete squares.
    const auto ratio = std::max(static_cast<double>(width), static_cast<double>(height)) / static_cast<double>(longest_edge_);
    if (ratio > 1) {
        width = std::max<std::size_t>(1, static_cast<std::size_t>(std::floor(static_cast<double>(width) / ratio)));
        height = std::max<std::size_t>(1, static_cast<std::size_t>(std::floor(static_cast<double>(height) / ratio)));
    }
    const auto unit = patch_ * merge_;
    return {std::min(longest_edge_, ((width - 1) / unit + 1) * unit), std::min(longest_edge_, ((height - 1) / unit + 1) * unit)};
}

std::vector<float> Eye::prepare(std::span<const std::uint8_t> rgb, std::size_t width, std::size_t height, std::size_t &out_width, std::size_t &out_height) const {
    const auto [target_width, target_height] = fit(width, height);
    if (rgb.size() != width * height * 3) { throw std::runtime_error("RGB pixel data does not match the image size"); }
    out_width = target_width; out_height = target_height;
    std::vector<float> result(3 * target_width * target_height);
    const auto scale_x = static_cast<double>(width) / static_cast<double>(target_width);
    const auto scale_y = static_cast<double>(height) / static_cast<double>(target_height);
    for (std::size_t y = 0; y < target_height; ++y) {
        const auto source_y = std::clamp((static_cast<double>(y) + 0.5) * scale_y - 0.5, 0.0, static_cast<double>(height - 1));
        const auto y0 = static_cast<std::size_t>(source_y); const auto y1 = std::min(y0 + 1, height - 1); const auto wy = source_y - static_cast<double>(y0);
        for (std::size_t x = 0; x < target_width; ++x) {
            const auto source_x = std::clamp((static_cast<double>(x) + 0.5) * scale_x - 0.5, 0.0, static_cast<double>(width - 1));
            const auto x0 = static_cast<std::size_t>(source_x); const auto x1 = std::min(x0 + 1, width - 1); const auto wx = source_x - static_cast<double>(x0);
            for (std::size_t c = 0; c < 3; ++c) {
                const auto at = [&](std::size_t px, std::size_t py) { return static_cast<double>(rgb[(py * width + px) * 3 + c]); };
                const auto value = (at(x0, y0) * (1 - wx) + at(x1, y0) * wx) * (1 - wy) + (at(x0, y1) * (1 - wx) + at(x1, y1) * wx) * wy;
                result[(c * target_height + y) * target_width + x] = (static_cast<float>(value / 255.0) - mean_[c]) / deviation_[c];
            }
        }
    }
    return result;
}

void Eye::linear(const Tensor *matrix, std::size_t columns, std::size_t rows, std::span<const float> input, std::size_t tokens, std::span<float> output, const std::function<bool()> &cancelled) const {
    const auto weights = model_.data(*matrix);
    const auto stride = row_bytes(matrix->type, columns);
    static const bool precise = environment_set("STELLAN_RUNTIME_PRECISE");
    if (!precise && matrix->type == 8) {
        // Q8_0 weights: quantise each token's input to int8 in 32-value blocks (one scale per weight
        // block, as llama.cpp does), then reuse each weight row for up to 32 tokens at a time.
        const auto blocks = columns / 32;
        std::vector<FineInput> quantized(tokens * blocks);
        executor_.parallel(tokens, [&](std::size_t first, std::size_t last) {
            for (auto t = first; t < last; ++t) { quantize_fine(input.subspan(t * columns, columns), std::span(quantized).subspan(t * blocks, blocks)); }
        });
        std::vector<std::span<const FineInput>> spans(tokens);
        for (std::size_t t = 0; t < tokens; ++t) { spans[t] = std::span<const FineInput>(quantized).subspan(t * blocks, blocks); }
        // Blocks of 64 weight rows against chunks of 32 tokens: both stay in the cache while every row of the
        // block meets every token of the chunk, instead of re-reading all tokens from memory for each row.
        constexpr std::size_t row_block = 64;
        executor_.parallel((rows + row_block - 1) / row_block, [&](std::size_t first, std::size_t last) {
            std::array<float, prefill_batch_limit> results {};
            for (auto block = first; block < last; ++block) {
                if (cancelled()) { throw std::runtime_error("Image encoding cancelled"); }
                const auto start = block * row_block, end = std::min(rows, start + row_block);
                for (std::size_t t = 0; t < tokens; t += prefill_batch_limit) {
                    const auto count = std::min(prefill_batch_limit, tokens - t);
                    for (auto r = start; r < end; ++r) {
                        fine_batch_dot(weights.subspan(r * stride, stride), std::span(spans).subspan(t, count), std::span(results).first(count));
                        for (std::size_t i = 0; i < count; ++i) { output[(t + i) * rows + r] = results[i]; }
                    }
                }
            }
        });
        return;
    }
    constexpr std::size_t tile = 16;
    // Each worker decodes a tile of weight rows once and reuses it for every token.
    executor_.parallel((rows + tile - 1) / tile, [&](std::size_t first, std::size_t last) {
        std::vector<float> decoded(tile * columns);
        for (auto block = first; block < last; ++block) {
            if (cancelled()) { throw std::runtime_error("Image encoding cancelled"); }
            const auto start = block * tile; const auto count = std::min(tile, rows - start);
            for (std::size_t r = 0; r < count; ++r) { decode_row(matrix->type, weights.subspan((start + r) * stride, stride), std::span(decoded).subspan(r * columns, columns)); }
            for (std::size_t t = 0; t < tokens; ++t) {
                const auto *x = input.data() + t * columns;
                for (std::size_t r = 0; r < count; ++r) { output[t * rows + start + r] = dot_floats(decoded.data() + r * columns, x, columns); }
            }
        }
    });
}

void Eye::normalize(std::span<float> values, std::size_t tokens, std::span<const float> weights) const {
    const auto width = weights.size();
    for (std::size_t t = 0; t < tokens; ++t) {
        auto row = values.subspan(t * width, width);
        double sum = 0;
        for (const auto value : row) { sum += static_cast<double>(value) * value; }
        const auto scale = static_cast<float>(1 / std::sqrt(sum / static_cast<double>(width) + epsilon_));
        for (std::size_t i = 0; i < width; ++i) { row[i] = row[i] * scale * weights[i]; }
    }
}

Eye::Result Eye::encode(std::span<const float> pixels, std::size_t width, std::size_t height, const std::function<bool()> &cancelled) const {
    const auto unit = patch_ * merge_;
    if (width == 0 || height == 0 || width % unit != 0 || height % unit != 0 || width > longest_edge_ || height > longest_edge_ || pixels.size() != 3 * width * height) {
        throw std::runtime_error("Image must be prepared to whole merged patches within the longest edge");
    }
    if (!std::all_of(pixels.begin(), pixels.end(), [](float value) { return std::isfinite(value); })) { throw std::runtime_error("Non-finite image input"); }
    const auto columns = width / patch_, rows = height / patch_, tokens = rows * columns;
    // Patch embedding: a stride-patch convolution is a matrix multiply over flattened (channel, y, x) patches.
    const auto patch_size = 3 * patch_ * patch_;
    std::vector<float> patches(tokens * patch_size);
    for (std::size_t py = 0; py < rows; ++py) {
        for (std::size_t px = 0; px < columns; ++px) {
            auto *out = patches.data() + (py * columns + px) * patch_size;
            for (std::size_t c = 0; c < 3; ++c) {
                for (std::size_t y = 0; y < patch_; ++y) {
                    const auto *line = pixels.data() + (c * height + py * patch_ + y) * width + px * patch_;
                    std::copy(line, line + patch_, out + (c * patch_ + y) * patch_);
                }
            }
        }
    }
    std::vector<float> hidden(tokens * width_);
    linear(patch_embedding_, patch_size, width_, patches, tokens, hidden, cancelled);
    patches.clear(); patches.shrink_to_fit();
    normalize(hidden, tokens, pre_norm_);
    // 2D RoPE as llama.cpp stores Pixtral (adjacent pairs): the first half of each head turns with the
    // patch row, the second half with the column, using the even and odd frequencies respectively.
    const auto quarter = head_width_ / 4;
    std::vector<float> row_cos(rows * quarter), row_sin(rows * quarter), column_cos(columns * quarter), column_sin(columns * quarter);
    for (std::size_t p = 0; p < quarter; ++p) {
        const auto even = std::pow(rope_base_, -4.0 * static_cast<double>(p) / static_cast<double>(head_width_));
        const auto odd = std::pow(rope_base_, -(4.0 * static_cast<double>(p) + 2.0) / static_cast<double>(head_width_));
        for (std::size_t y = 0; y < rows; ++y) { row_cos[y * quarter + p] = static_cast<float>(std::cos(static_cast<double>(y) * even)); row_sin[y * quarter + p] = static_cast<float>(std::sin(static_cast<double>(y) * even)); }
        for (std::size_t x = 0; x < columns; ++x) { column_cos[x * quarter + p] = static_cast<float>(std::cos(static_cast<double>(x) * odd)); column_sin[x * quarter + p] = static_cast<float>(std::sin(static_cast<double>(x) * odd)); }
    }
    const auto rotate = [&](std::span<float> values) {
        for (std::size_t t = 0; t < tokens; ++t) {
            const auto y = t / columns, x = t % columns;
            for (std::size_t h = 0; h < heads_; ++h) {
                auto *head = values.data() + t * width_ + h * head_width_;
                for (std::size_t p = 0; p < 2 * quarter; ++p) {
                    const bool first_half = p < quarter;
                    const auto c = first_half ? row_cos[y * quarter + p] : column_cos[x * quarter + p - quarter];
                    const auto s = first_half ? row_sin[y * quarter + p] : column_sin[x * quarter + p - quarter];
                    const auto a = head[2 * p], b = head[2 * p + 1];
                    head[2 * p] = a * c - b * s; head[2 * p + 1] = a * s + b * c;
                }
            }
        }
    };
    std::vector<float> normalized(tokens * width_), query(tokens * width_), key(tokens * width_), value(tokens * width_), attended(tokens * width_), update(tokens * width_);
    std::vector<float> gate(tokens * feed_forward_), up(tokens * feed_forward_), keys_by_head(tokens * width_), values_by_head(tokens * width_);
    const auto scale = 1 / std::sqrt(static_cast<float>(head_width_));
    for (const auto &layer : layers_) {
        normalized = hidden;
        normalize(normalized, tokens, layer.attention_norm);
        linear(layer.q, width_, width_, normalized, tokens, query, cancelled);
        linear(layer.k, width_, width_, normalized, tokens, key, cancelled);
        linear(layer.v, width_, width_, normalized, tokens, value, cancelled);
        rotate(query); rotate(key);
        // Regroup keys and values head by head so each head's rows are contiguous: in token order they sit
        // width_ floats apart, and that power-of-two stride makes them compete for the same cache sets.
        for (std::size_t t = 0; t < tokens; ++t) {
            for (std::size_t h = 0; h < heads_; ++h) {
                std::copy_n(key.data() + t * width_ + h * head_width_, head_width_, keys_by_head.data() + (h * tokens + t) * head_width_);
                std::copy_n(value.data() + t * width_ + h * head_width_, head_width_, values_by_head.data() + (h * tokens + t) * head_width_);
            }
        }
        // Every patch attends to every patch of the same image (no causal mask).
        executor_.parallel(heads_ * tokens, [&](std::size_t first, std::size_t last) {
            std::vector<float> scores(tokens);
            for (auto item = first; item < last; ++item) {
                if (cancelled()) { throw std::runtime_error("Image encoding cancelled"); }
                const auto h = item / tokens, t = item % tokens;
                const auto *q = query.data() + t * width_ + h * head_width_;
                const auto *keys = keys_by_head.data() + h * tokens * head_width_;
                const auto *values = values_by_head.data() + h * tokens * head_width_;
                auto *out = attended.data() + t * width_ + h * head_width_;
                if (accelerated_attention(tokens, head_width_, head_width_, q, keys, values, scale, scores.data(), out)) { continue; }
                float maximum = -INFINITY;
                for (std::size_t j = 0; j < tokens; ++j) { scores[j] = dot_floats(q, keys + j * head_width_, head_width_) * scale; maximum = std::max(maximum, scores[j]); }
                float denominator = 0;
                for (auto &score : scores) { score = std::exp(score - maximum); denominator += score; }
                std::fill(out, out + head_width_, 0.0F);
                for (std::size_t j = 0; j < tokens; ++j) {
                    const auto weight = scores[j] / denominator;
                    const auto *v = values + j * head_width_;
                    for (std::size_t i = 0; i < head_width_; ++i) { out[i] += weight * v[i]; }
                }
            }
        });
        linear(layer.out, width_, width_, attended, tokens, update, cancelled);
        for (std::size_t i = 0; i < hidden.size(); ++i) { hidden[i] += update[i]; }
        normalized = hidden;
        normalize(normalized, tokens, layer.ffn_norm);
        linear(layer.gate, width_, feed_forward_, normalized, tokens, gate, cancelled);
        linear(layer.up, width_, feed_forward_, normalized, tokens, up, cancelled);
        for (std::size_t i = 0; i < gate.size(); ++i) { gate[i] = gate[i] / (1 + std::exp(-gate[i])) * up[i]; }
        linear(layer.down, feed_forward_, width_, gate, tokens, update, cancelled);
        for (std::size_t i = 0; i < hidden.size(); ++i) { hidden[i] += update[i]; }
    }
    gate.clear(); gate.shrink_to_fit(); up.clear(); up.shrink_to_fit();
    Result result;
    result.rows = rows / merge_; result.columns = columns / merge_;
    const auto merged_tokens = result.rows * result.columns;
    std::vector<float> merged;
    if (merge_ > 1) {
        // Mistral 3's patch merger: RMSNorm, then each merge x merge square of patches becomes one vector
        // ordered as torch.nn.functional.unfold does (channel-major, then row and column inside the square).
        normalize(hidden, tokens, merger_norm_);
        const auto square = merge_ * merge_;
        std::vector<float> gathered(merged_tokens * width_ * square);
        for (std::size_t r = 0; r < result.rows; ++r) {
            for (std::size_t c = 0; c < result.columns; ++c) {
                auto *out = gathered.data() + (r * result.columns + c) * width_ * square;
                for (std::size_t ky = 0; ky < merge_; ++ky) {
                    for (std::size_t kx = 0; kx < merge_; ++kx) {
                        const auto *source = hidden.data() + ((r * merge_ + ky) * columns + c * merge_ + kx) * width_;
                        for (std::size_t channel = 0; channel < width_; ++channel) { out[channel * square + ky * merge_ + kx] = source[channel]; }
                    }
                }
            }
        }
        merged.resize(merged_tokens * width_);
        linear(merger_, width_ * square, width_, gathered, merged_tokens, merged, cancelled);
    } else {
        merged = std::move(hidden);
    }
    std::vector<float> projected(merged_tokens * hidden_width_);
    linear(projector_in_, width_, hidden_width_, merged, merged_tokens, projected, cancelled);
    for (std::size_t t = 0; t < merged_tokens; ++t) {
        for (std::size_t i = 0; i < hidden_width_; ++i) {
            auto &x = projected[t * hidden_width_ + i];
            if (!projector_in_bias_.empty()) { x += projector_in_bias_[i]; }
            x = 0.5F * x * (1 + std::erf(x / std::sqrt(2.0F)));
        }
    }
    result.embeddings.resize(merged_tokens * output_width_);
    linear(projector_out_, hidden_width_, output_width_, projected, merged_tokens, result.embeddings, cancelled);
    if (!projector_out_bias_.empty()) {
        for (std::size_t t = 0; t < merged_tokens; ++t) { for (std::size_t i = 0; i < output_width_; ++i) { result.embeddings[t * output_width_ + i] += projector_out_bias_[i]; } }
    }
    if (!std::all_of(result.embeddings.begin(), result.embeddings.end(), [](float value) { return std::isfinite(value); })) { throw std::runtime_error("Image encoder produced non-finite output"); }
    if (break_token_ != nullptr) {
        result.break_embedding.resize(output_width_);
        decode_row(break_token_->type, model_.data(*break_token_), result.break_embedding);
    }
    return result;
}
}
