#include "runtime.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <limits>

namespace stellan {
bool accelerated_quantized_dot(std::uint32_t, std::span<const std::byte>, std::span<const QuantizedInput>, float &);

bool accelerated_quantized_batch_dot(std::uint32_t, std::span<const std::byte>, std::span<const std::span<const QuantizedInput>>, std::span<float>);

std::vector<QuantizedInput> quantize_input(std::span<const float> input) {
    if (input.empty() || input.size() % 256 != 0) { throw std::runtime_error("Quantized activations need complete 256-value blocks"); }
    std::vector<QuantizedInput> result(input.size() / 256);
    for (std::size_t b = 0; b < result.size(); ++b) {
        auto &block = result[b];
        float maximum = 0;
        for (std::size_t i = 0; i < 256; ++i) {
            const auto value = input[b * 256 + i];
            if (!std::isfinite(value)) { throw std::runtime_error("Non-finite matrix input"); }
            maximum = std::max(maximum, std::abs(value));
        }
        block.scale = maximum == 0 ? 0 : std::max(maximum / 127, std::numeric_limits<float>::denorm_min());
        block.sums.fill(0);
        for (std::size_t i = 0; i < 256; ++i) {
            const auto value = maximum == 0 ? 0 : static_cast<int>(std::clamp(std::nearbyint(input[b * 256 + i] / block.scale), -127.0F, 127.0F));
            block.values[i] = static_cast<std::int8_t>(value);
            block.sums[i / 16] = static_cast<std::int16_t>(block.sums[i / 16] + value);
        }
    }
    return result;
}

float quantized_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const QuantizedInput> input) {
    if ((type != 12 && type != 14) || input.empty() || row.size() != row_bytes(type, input.size() * 256)) {
        throw std::runtime_error("Invalid quantized matrix row");
    }
    float sum = 0;
    if (accelerated_quantized_dot(type, row, input, sum)) { return sum; }
    const auto stride = type == 12 ? 144U : 210U;
    std::array<float, 256> expanded;
    for (std::size_t b = 0; b < input.size(); ++b) {
        decode_row(type, row.subspan(b * stride, stride), expanded);
        float partial = 0;
        for (std::size_t i = 0; i < 256; ++i) { partial += expanded[i] * input[b].values[i]; }
        sum += partial * input[b].scale;
    }
    return sum;
}
void quantized_batch_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    if ((type != 12 && type != 14) || input.empty() || input.size() > prefill_batch_limit || input.size() != output.size() || input.front().empty() ||
        !std::all_of(input.begin(), input.end(), [&](const auto values) { return values.size() == input.front().size(); }) || row.size() != row_bytes(type, input.front().size() * 256)) {
        throw std::runtime_error("Invalid batched quantized matrix row");
    }
    if (accelerated_quantized_batch_dot(type, row, input, output)) { return; }
    std::fill(output.begin(), output.end(), 0.0f);
    const auto stride = type == 12 ? 144U : 210U;
    std::array<float, 256> expanded;
    for (std::size_t b = 0; b < input.front().size(); ++b) {
        decode_row(type, row.subspan(b * stride, stride), expanded);
        for (std::size_t t = 0; t < input.size(); ++t) {
            float partial = 0;
            for (std::size_t i = 0; i < 256; ++i) partial += expanded[i] * input[t][b].values[i];
            output[t] += partial * input[t][b].scale;
        }
    }
}

}
