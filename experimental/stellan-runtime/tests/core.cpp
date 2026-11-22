#include "runtime.hpp"
#include "executor.hpp"

#include <array>
#include <algorithm>
#include <atomic>
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
        if (exponent != 31 || mantissa == 0) { require(stellan::to_half(result) == bits); }
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

void additional_kernels() {
    std::mt19937 random(42);
    for (unsigned trial = 0; trial < 100; ++trial) {
        std::array<std::byte, 210> packed {};
        std::array<float, 256> input {};
        set_half(packed, 208, 0x2000);
        double expected = 0;
        for (std::size_t i = 0; i < 16; ++i) { packed[192 + i] = static_cast<std::byte>(random() % 256); }
        for (std::size_t i = 0; i < 256; ++i) {
            const auto value = static_cast<unsigned>(random() % 64);
            const auto quarter = (i % 128) / 32;
            const auto lane = i % 32;
            packed[(i / 128) * 64 + (quarter % 2) * 32 + lane] |= static_cast<std::byte>((value & 15) << (quarter < 2 ? 0 : 4));
            packed[128 + (i / 128) * 32 + lane] |= static_cast<std::byte>((value >> 4) << (quarter * 2));
            input[i] = static_cast<float>(static_cast<int>(random() % 201) - 100) / 100;
            const auto raw = std::to_integer<int>(packed[192 + i / 16]);
            expected += (static_cast<int>(value) - 32) * (raw < 128 ? raw : raw - 256) * 0.0078125 * input[i];
        }
        close(stellan::dot(14, packed, input), expected, 3e-5);
    }
    require(stellan::sha256({}) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const std::string abc = "abc";
    require(stellan::sha256(std::as_bytes(std::span(abc))) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const std::string padding = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    require(stellan::sha256(std::as_bytes(std::span(padding))) == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    const std::string million(1000000, 'a');
    require(stellan::sha256(std::as_bytes(std::span(million))) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    for (const auto threads : {1U, 2U, 7U}) {
        stellan::Executor executor(threads);
        std::vector<unsigned> values(1009);
        for (unsigned iteration = 0; iteration < 20; ++iteration) {
            executor.parallel(values.size(), [&](std::size_t first, std::size_t last) {
                for (auto i = first; i < last; ++i) { values[i] = iteration; }
            });
            require(std::all_of(values.begin(), values.end(), [&](unsigned value) { return value == iteration; }));
        }
        rejects([&] { executor.parallel(values.size(), [](auto, auto) { throw std::runtime_error("worker failure"); }); });
        executor.parallel(0, [](auto first, auto last) { if (first != last) { throw std::runtime_error("range"); } });
    }
    rejects([] { stellan::Executor executor(0); });
    rejects([] { stellan::Executor executor(65); });
    require(stellan::to_half(1.00048828125F) == 0x3c00);
    require(stellan::to_half(1.00146484375F) == 0x3c02);
    require(stellan::to_half(std::ldexp(1.0F, -25)) == 0);
    for (const auto type : {12U, 14U}) {
        const auto stride = type == 12 ? 144U : 210U;
        for (unsigned trial = 0; trial < 100; ++trial) {
            std::vector<std::byte> weights(stride * 3);
            std::vector<float> input(768);
            for (auto &byte : weights) { byte = static_cast<std::byte>(random() % 256); }
            for (auto &value : input) { value = static_cast<float>(static_cast<int>(random() % 2001) - 1000) / 1000; }
            for (std::size_t block = 0; block < 3; ++block) {
                set_half(weights, block * stride + (type == 12 ? 0 : 208), 0x2800);
                if (type == 12) { set_half(weights, block * stride + 2, 0x2400); }
            }
            const auto quantized = stellan::quantize_input(input);
            std::vector<float> represented(input.size());
            for (std::size_t block = 0; block < 3; ++block) {
                for (std::size_t group = 0; group < 16; ++group) {
                    int sum = 0;
                    for (std::size_t i = 0; i < 16; ++i) { sum += quantized[block].values[group * 16 + i]; }
                    require(sum == quantized[block].sums[group]);
                }
                for (std::size_t i = 0; i < 256; ++i) { represented[block * 256 + i] = quantized[block].values[i] * quantized[block].scale; }
            }
            const auto actual = stellan::quantized_dot(type, weights, quantized);
            const auto expected = stellan::dot(type, weights, represented);
            require(std::abs(actual - expected) <= 0.005F + std::abs(expected) * 0.00005F);
        }
    }
    const std::array<float, 256> zero {};
    const auto quantized_zero = stellan::quantize_input(zero);
    std::array<std::byte, 144> weights {};
    require(stellan::quantized_dot(12, weights, quantized_zero) == 0);
    auto tiny = zero;
    tiny[0] = std::numeric_limits<float>::denorm_min();
    require(std::isfinite(stellan::quantize_input(tiny)[0].scale));
    tiny[0] = std::numeric_limits<float>::infinity();
    rejects([&] { stellan::quantize_input(tiny); });
    std::array<float, 128> b {};
    std::array<float, 128> c {};
    for (std::size_t i = 0; i < b.size(); ++i) { b[i] = static_cast<float>(i) / 512; c[i] = 0.5F - b[i]; }
    std::array<float, 256> state {};
    std::array<double, 256> reference {};
    const std::array<float, 2> x {0.5F, -0.2F};
    const std::array<float, 1> dt {0.1F};
    const std::array<float, 1> decay {-2};
    const std::array<float, 1> skip {0.1F};
    std::array<float, 2> output {};
    for (unsigned step = 0; step < 10; ++step) {
        stellan::mamba2_step(1, 2, 128, 1, x, dt, decay, b, c, skip, state, output);
        for (std::size_t channel = 0; channel < 2; ++channel) {
            double expected = skip[0] * x[channel];
            for (std::size_t i = 0; i < 128; ++i) {
                auto &memory = reference[channel * 128 + i];
                memory = std::exp(static_cast<double>(dt[0]) * decay[0]) * memory + dt[0] * b[i] * x[channel];
                expected += c[i] * memory;
                close(state[channel * 128 + i], memory);
            }
            close(output[channel], expected);
        }
    }
}
}

int main() {
    try {
        halves();
        quantized();
        recurrence();
        additional_kernels();
        require(stellan::json_string("a\n\"\\") == "\"a\\u000a\\\"\\\\\"");
        std::cout << checks << " checks passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
