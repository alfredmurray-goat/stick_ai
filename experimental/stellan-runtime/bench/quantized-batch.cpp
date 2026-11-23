#include "runtime.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <vector>

int main() {
    constexpr std::size_t width = 4096, batch = 32;
    constexpr int iterations = 500;
    std::vector<std::vector<stellan::QuantizedInput>> inputs;
    std::vector<std::span<const stellan::QuantizedInput>> views;
    for (std::size_t t = 0; t < batch; ++t) {
        std::vector<float> values(width);
        for (std::size_t i = 0; i < width; ++i) values[i] = static_cast<float>(static_cast<int>((i * 17 + t * 13) % 251) - 125) / 125;
        inputs.push_back(stellan::quantize_input(values));
    }
    for (const auto &values : inputs) views.emplace_back(values);
    std::cout << "{\"scope\":\"synthetic-quantized-prefill-only\",\"scalar\":" << (stellan::environment_set("STELLAN_RUNTIME_SCALAR") ? "true" : "false") << ",\"rows\":[";
    bool first = true;
    for (const auto type : {12U, 14U}) {
        const auto stride = type == 12 ? 144U : 210U;
        std::vector<std::byte> weights(width / 256 * stride);
        for (std::size_t i = 0; i < weights.size(); ++i) weights[i] = static_cast<std::byte>((i * 37 + 19) % 256);
        for (std::size_t b = 0; b < width / 256; ++b) {
            const auto base = b * stride + (type == 12 ? 0U : 208U);
            weights[base] = std::byte{0}; weights[base + 1] = std::byte{0x38};
            if (type == 12) { weights[base + 2] = std::byte{0}; weights[base + 3] = std::byte{0x2c}; }
        }
        for (const std::size_t count : {1U, 8U, 32U}) {
            std::vector<float> output(count);
            for (int warm = 0; warm < 5; ++warm) stellan::quantized_batch_dot(type, weights, std::span(views).first(count), output);
            const auto start = std::chrono::steady_clock::now();
            for (int i = 0; i < iterations; ++i) stellan::quantized_batch_dot(type, weights, std::span(views).first(count), output);
            const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            double checksum = 0;
            for (const auto value : output) { if (!std::isfinite(value)) return 1; checksum += value; }
            if (!first) std::cout << ',';
            first = false;
            std::cout << "{\"type\":" << type << ",\"width\":" << width << ",\"batch\":" << count << ",\"iterations\":" << iterations << ",\"ms\":" << ms << ",\"checksum\":" << checksum << '}';
        }
    }
    std::cout << "]}\n";
}
