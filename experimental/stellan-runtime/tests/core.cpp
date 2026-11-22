#include "runtime.hpp"

#include <array>
#include <bit>
#include <cmath>
#include <iostream>
#include <limits>
#include <random>
#include <stdexcept>

namespace {
unsigned checks = 0;
void require(bool value) {
    ++checks;
    if (!value) { throw std::runtime_error("Check " + std::to_string(checks) + " failed"); }
}
void close(double actual, double expected, double tolerance = 1e-5) {
    require(std::abs(actual - expected) <= tolerance * (1 + std::abs(expected)));
}
template<class F> void rejects(F action) {
    bool rejected = false;
    try { action(); } catch (const std::runtime_error &) { rejected = true; }
    require(rejected);
}
void set_half(std::span<std::byte> bytes, std::size_t offset, std::uint16_t bits) {
    bytes[offset] = static_cast<std::byte>(bits & 255);
    bytes[offset + 1] = static_cast<std::byte>(bits >> 8);
}

void halves() {
    for (unsigned bits = 0; bits < 65536; ++bits) {
        const auto exponent = (bits >> 10) & 31;
        const auto mantissa = bits & 1023;
        const auto result = stellan::half(static_cast<std::uint16_t>(bits));
        if (exponent == 31) {
            require(mantissa == 0 ? std::isinf(result) : std::isnan(result));
        } else {
            const auto expected = exponent == 0 ? std::ldexp(static_cast<double>(mantissa), -24) :
                std::ldexp(1.0 + static_cast<double>(mantissa) / 1024, static_cast<int>(exponent) - 15);
            require(result == ((bits & 32768) ? -expected : expected));
            require(std::signbit(result) == ((bits & 32768) != 0));
        }
    }
}

void quantized() {
    std::mt19937 random(1201);
    for (unsigned trial = 0; trial < 200; ++trial) {
        std::array<std::byte, 288> weights {};
        std::array<float, 512> input {};
        double expected = 0;
        for (std::size_t block = 0; block < 2; ++block) {
            const auto base = block * 144;
            set_half(weights, base, 0x2800);
            set_half(weights, base + 2, 0x2400);
            std::array<unsigned, 8> scales {};
            std::array<unsigned, 8> minima {};
            for (std::size_t g = 0; g < 8; ++g) {
                scales[g] = static_cast<unsigned>(random() % 64);
                minima[g] = static_cast<unsigned>(random() % 64);
            }
            for (std::size_t g = 0; g < 4; ++g) {
                weights[base + 4 + g] = static_cast<std::byte>(scales[g] | ((scales[g + 4] >> 4) << 6));
                weights[base + 8 + g] = static_cast<std::byte>(minima[g] | ((minima[g + 4] >> 4) << 6));
                weights[base + 12 + g] = static_cast<std::byte>((scales[g + 4] & 15) | ((minima[g + 4] & 15) << 4));
            }
            for (std::size_t g = 0; g < 8; ++g) {
                for (std::size_t j = 0; j < 32; ++j) {
                    const auto q = static_cast<unsigned>(random() % 16);
                    weights[base + 16 + (g / 2) * 32 + j] |= static_cast<std::byte>(q << ((g % 2) * 4));
                    const auto index = block * 256 + g * 32 + j;
                    input[index] = static_cast<float>(static_cast<int>(random() % 2001) - 1000) / 1000;
                    const double expanded = 0.03125 * scales[g] * q - 0.015625 * minima[g];
                    expected += expanded * input[index];
                }
            }
        }
        close(stellan::dot(12, weights, input), expected, 2e-5);
    }
    std::array<std::byte, 34> q8 {};
    set_half(q8, 0, 0x3800);
    std::array<float, 32> input;
    input.fill(1);
    for (std::size_t i = 0; i < 32; ++i) { q8[2 + i] = static_cast<std::byte>(i % 2 == 0 ? 128 : 127); }
    close(stellan::dot(8, q8, input), -8);
    rejects([&] { stellan::dot(8, std::span(q8).first(33), input); });
    rejects([] { stellan::row_bytes(12, 255); });
    rejects([] { stellan::row_bytes(999, 256); });
    rejects([] { stellan::row_bytes(0, std::numeric_limits<std::size_t>::max()); });
    const std::array<float, 6> values {1, 2, 3, -1, -2, -3};
    const std::array<float, 3> vector {4, 5, 6};
    std::array<float, 2> output {};
    stellan::matvec(0, std::as_bytes(std::span(values)), 2, vector, output);
    close(output[0], 32);
    close(output[1], -32);
    rejects([&] { stellan::matvec(0, std::as_bytes(std::span(values)), 3, vector, output); });
    const std::array<std::byte, 4> f16 {std::byte(0), std::byte(0x3c), std::byte(0), std::byte(0xc0)};
    const std::array<float, 2> pair {3, 4};
    close(stellan::dot(1, f16, pair), -5);
}

void recurrence() {
    constexpr std::size_t heads = 4;
    constexpr std::size_t width = 3;
    constexpr std::size_t states = 5;
    constexpr std::size_t groups = 2;
    std::array<float, heads * width> x {};
    const std::array<float, heads> dt {0.1F, 0.2F, 0.3F, 0.4F};
    const std::array<float, heads> decay {-1, -2, -3, -4};
    const std::array<float, heads> skip {1, 2, 3, 4};
    std::array<float, groups * states> b {};
    std::array<float, groups * states> c {};
    for (std::size_t i = 0; i < b.size(); ++i) { b[i] = static_cast<float>(i + 1) / 10; c[i] = 1 - b[i]; }
    std::array<float, heads * width * states> state {};
    std::array<float, heads * width> output {};
    std::vector<std::array<float, heads * width>> history;
    for (unsigned step = 0; step < 7; ++step) {
        for (std::size_t i = 0; i < x.size(); ++i) { x[i] = static_cast<float>(i + step + 1) / 7; }
        history.push_back(x);
        stellan::mamba2_step(heads, width, states, groups, x, dt, decay, b, c, skip, state, output);
        for (std::size_t h = 0; h < heads; ++h) {
            for (std::size_t p = 0; p < width; ++p) {
                const auto channel = h * width + p;
                double expected = skip[h] * x[channel];
                for (std::size_t n = 0; n < states; ++n) {
                    double memory = 0;
                    for (std::size_t t = 0; t < history.size(); ++t) {
                        memory += std::exp(static_cast<double>(dt[h]) * decay[h] * static_cast<double>(history.size() - t - 1)) *
                            dt[h] * b[(h / 2) * states + n] * history[t][channel];
                    }
                    expected += c[(h / 2) * states + n] * memory;
                }
                close(output[channel], expected);
            }
        }
    }
    auto saved = state;
    stellan::mamba2_step(heads, width, states, groups, x, dt, decay, b, c, skip, state, output);
    const auto expected = output;
    stellan::mamba2_step(heads, width, states, groups, x, dt, decay, b, c, skip, saved, output);
    require(expected == output);
    rejects([&] { stellan::mamba2_step(heads, width, states, 3, x, dt, decay, b, c, skip, state, output); });
    for (const auto bad : {-1.0F, std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN()}) {
        auto invalid = dt;
        invalid[3] = bad;
        const auto before = state;
        rejects([&] { stellan::mamba2_step(heads, width, states, groups, x, invalid, decay, b, c, skip, state, output); });
        require(before == state);
    }
    auto invalid_decay = decay;
    invalid_decay[0] = 1;
    rejects([&] { stellan::mamba2_step(heads, width, states, groups, x, dt, invalid_decay, b, c, skip, state, output); });
}
}

int main() {
    try {
        halves();
        quantized();
        recurrence();
        require(stellan::json_string("a\n\"\\") == "\"a\\u000a\\\"\\\\\"");
        std::cout << checks << " checks passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
