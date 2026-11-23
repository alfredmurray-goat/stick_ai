#include "runtime.hpp"

#include <algorithm>
#include <bit>
#include <cstdlib>

#if defined(__x86_64__) || defined(__i386__) || defined(_M_X64)
#include <immintrin.h>
#ifdef _MSC_VER
#include <intrin.h>
#define STELLAN_AVX2
#else
#define STELLAN_AVX2 __attribute__((target("avx2,fma,f16c")))
#endif

namespace stellan {
namespace {
std::uint16_t read_half(const std::byte *p) {
    return static_cast<std::uint16_t>(std::to_integer<unsigned>(p[0]) | (std::to_integer<unsigned>(p[1]) << 8));
}
bool available() {
    if (environment_set("STELLAN_RUNTIME_SCALAR")) { return false; }
#ifdef _MSC_VER
    int registers[4];
    __cpuid(registers, 1);
    if ((registers[2] & (1 << 27)) == 0 || (registers[2] & (1 << 28)) == 0 || (registers[2] & (1 << 12)) == 0 || (registers[2] & (1 << 29)) == 0 || (_xgetbv(0) & 6) != 6) { return false; }
    __cpuidex(registers, 7, 0);
    return (registers[1] & (1 << 5)) != 0;
#else
    return __builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma") && __builtin_cpu_supports("f16c");
#endif
}
STELLAN_AVX2 float half_float(std::uint16_t bits) {
    return _mm_cvtss_f32(_mm_cvtph_ps(_mm_cvtsi32_si128(static_cast<int>(bits))));
}
STELLAN_AVX2 float packed_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const float> input) {
    auto sum = _mm256_setzero_ps();
    const auto mask = _mm256_set1_epi32(15);
    for (std::size_t block = 0; block < input.size() / 256; ++block) {
        const auto *p = row.data() + block * (type == 12 ? 144 : 210);
        if (type == 12) {
            const auto d = half_float(read_half(p));
            const auto minimum = half_float(read_half(p + 2));
            for (std::size_t g = 0; g < 8; ++g) {
                const auto *s = p + 4;
                const auto scale = g < 4 ? std::to_integer<unsigned>(s[g]) & 63U :
                    (std::to_integer<unsigned>(s[g + 4]) & 15U) | ((std::to_integer<unsigned>(s[g - 4]) >> 6) << 4);
                const auto offset = g < 4 ? std::to_integer<unsigned>(s[g + 4]) & 63U :
                    (std::to_integer<unsigned>(s[g + 4]) >> 4) | ((std::to_integer<unsigned>(s[g]) >> 6) << 4);
                const auto multiplier = _mm256_set1_ps(d * static_cast<float>(scale));
                const auto bias = _mm256_set1_ps(minimum * static_cast<float>(offset));
                for (std::size_t j = 0; j < 32; j += 8) {
                    const auto bytes = _mm_loadl_epi64(reinterpret_cast<const __m128i *>(p + 16 + (g / 2) * 32 + j));
                    auto q = _mm256_cvtepu8_epi32(bytes);
                    if (g % 2 != 0) { q = _mm256_srli_epi32(q, 4); }
                    const auto values = _mm256_cvtepi32_ps(_mm256_and_si256(q, mask));
                    const auto weights = _mm256_fmsub_ps(values, multiplier, bias);
                    sum = _mm256_fmadd_ps(weights, _mm256_loadu_ps(input.data() + block * 256 + g * 32 + j), sum);
                }
            }
        } else {
            const auto d = half_float(read_half(p + 208));
            for (std::size_t g = 0; g < 8; ++g) {
                const auto half_block = g / 4;
                const auto quarter = g % 4;
                for (std::size_t j = 0; j < 32; j += 8) {
                    const auto low_bytes = _mm_loadl_epi64(reinterpret_cast<const __m128i *>(p + half_block * 64 + (quarter % 2) * 32 + j));
                    const auto high_bytes = _mm_loadl_epi64(reinterpret_cast<const __m128i *>(p + 128 + half_block * 32 + j));
                    auto low = _mm256_cvtepu8_epi32(low_bytes);
                    if (quarter >= 2) { low = _mm256_srli_epi32(low, 4); }
                    const auto high = _mm256_and_si256(_mm256_srlv_epi32(_mm256_cvtepu8_epi32(high_bytes), _mm256_set1_epi32(static_cast<int>(quarter * 2))), _mm256_set1_epi32(3));
                    const auto q = _mm256_sub_epi32(_mm256_or_si256(_mm256_and_si256(low, mask), _mm256_slli_epi32(high, 4)), _mm256_set1_epi32(32));
                    const auto raw = std::to_integer<int>(p[192 + g * 2 + j / 16]);
                    const auto scale = d * static_cast<float>(raw < 128 ? raw : raw - 256);
                    const auto weights = _mm256_mul_ps(_mm256_cvtepi32_ps(q), _mm256_set1_ps(scale));
                    sum = _mm256_fmadd_ps(weights, _mm256_loadu_ps(input.data() + block * 256 + g * 32 + j), sum);
                }
            }
        }
    }
    alignas(32) float lanes[8];
    _mm256_store_ps(lanes, sum);
    float total = 0;
    for (const auto value : lanes) { total += value; }
    return total;
}

STELLAN_AVX2 float q8_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const QuantizedInput> input) {
    float total = 0;
    for (std::size_t b = 0; b < input.size(); ++b) {
        const auto *p = row.data() + b * (type == 12 ? 144 : 210);
        auto accumulator = _mm256_setzero_si256();
        int minima = 0;
        for (std::size_t g = 0; g < 8; ++g) {
            if (type == 12) {
                const auto *s = p + 4;
                const auto scale = g < 4 ? std::to_integer<unsigned>(s[g]) & 63U :
                    (std::to_integer<unsigned>(s[g + 4]) & 15U) | ((std::to_integer<unsigned>(s[g - 4]) >> 6) << 4);
                const auto offset = g < 4 ? std::to_integer<unsigned>(s[g + 4]) & 63U :
                    (std::to_integer<unsigned>(s[g + 4]) >> 4) | ((std::to_integer<unsigned>(s[g]) >> 6) << 4);
                auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 16 + (g / 2) * 32));
                if (g % 2 != 0) { q = _mm256_srli_epi16(q, 4); }
                q = _mm256_and_si256(q, _mm256_set1_epi8(15));
                const auto x = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(input[b].values.data() + g * 32));
                const auto sums = _mm256_madd_epi16(_mm256_maddubs_epi16(q, x), _mm256_set1_epi16(1));
                accumulator = _mm256_add_epi32(accumulator, _mm256_mullo_epi32(sums, _mm256_set1_epi32(static_cast<int>(scale))));
                minima += static_cast<int>(offset) * (input[b].sums[g * 2] + input[b].sums[g * 2 + 1]);
            } else {
                const auto quarter = g % 4;
                for (std::size_t j = 0; j < 32; j += 16) {
                    auto low = _mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + (g / 4) * 64 + (quarter % 2) * 32 + j)));
                    if (quarter >= 2) { low = _mm256_srli_epi16(low, 4); }
                    const auto high = _mm256_srl_epi16(_mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + 128 + (g / 4) * 32 + j))), _mm_cvtsi32_si128(static_cast<int>(quarter * 2)));
                    const auto q = _mm256_sub_epi16(_mm256_or_si256(_mm256_and_si256(low, _mm256_set1_epi16(15)), _mm256_slli_epi16(_mm256_and_si256(high, _mm256_set1_epi16(3)), 4)), _mm256_set1_epi16(32));
                    const auto x = _mm256_cvtepi8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(input[b].values.data() + g * 32 + j)));
                    const auto raw = std::to_integer<int>(p[192 + g * 2 + j / 16]);
                    accumulator = _mm256_add_epi32(accumulator, _mm256_mullo_epi32(_mm256_madd_epi16(q, x), _mm256_set1_epi32(raw < 128 ? raw : raw - 256)));
                }
            }
        }
        alignas(32) std::int32_t lanes[8];
        _mm256_store_si256(reinterpret_cast<__m256i *>(lanes), accumulator);
        int sum = 0;
        for (const auto value : lanes) { sum += value; }
        if (type == 12) { total += input[b].scale * (half_float(read_half(p)) * static_cast<float>(sum) - half_float(read_half(p + 2)) * static_cast<float>(minima)); }
        else { total += input[b].scale * half_float(read_half(p + 208)) * static_cast<float>(sum); }
    }
    return total;
}
template<std::size_t Count>
STELLAN_AVX2 void q4_tile(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::fill(output.begin(), output.end(), 0.0f);
    for (std::size_t block = 0; block < input.front().size(); ++block) {
        const auto *p = row.data() + block * 144;
        __m256i accumulator[Count];
        int minima[Count] {};
        for (std::size_t t = 0; t < Count; ++t) { accumulator[t] = _mm256_setzero_si256(); }
        for (std::size_t g = 0; g < 8; ++g) {
            const auto *scales = p + 4;
            const auto scale = g < 4 ? std::to_integer<unsigned>(scales[g]) & 63U :
                (std::to_integer<unsigned>(scales[g + 4]) & 15U) | ((std::to_integer<unsigned>(scales[g - 4]) >> 6) << 4);
            const auto minimum = g < 4 ? std::to_integer<unsigned>(scales[g + 4]) & 63U :
                (std::to_integer<unsigned>(scales[g + 4]) >> 4) | ((std::to_integer<unsigned>(scales[g]) >> 6) << 4);
            auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 16 + (g / 2) * 32));
            if (g % 2 != 0) { q = _mm256_srli_epi16(q, 4); }
            q = _mm256_and_si256(q, _mm256_set1_epi8(15));
            const auto multiplier = _mm256_set1_epi32(static_cast<int>(scale));
            for (std::size_t t = 0; t < Count; ++t) {
                const auto &x = input[t][block];
                const auto values = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(x.values.data() + g * 32));
                const auto sums = _mm256_madd_epi16(_mm256_maddubs_epi16(q, values), _mm256_set1_epi16(1));
                accumulator[t] = _mm256_add_epi32(accumulator[t], _mm256_mullo_epi32(sums, multiplier));
                minima[t] += static_cast<int>(minimum) * (x.sums[g * 2] + x.sums[g * 2 + 1]);
            }
        }
        const auto scale = half_float(read_half(p));
        const auto minimum = half_float(read_half(p + 2));
        for (std::size_t t = 0; t < Count; ++t) {
            alignas(32) std::int32_t lanes[8];
            _mm256_store_si256(reinterpret_cast<__m256i *>(lanes), accumulator[t]);
            int sum = 0;
            for (const auto value : lanes) { sum += value; }
            output[t] += input[t][block].scale * (scale * static_cast<float>(sum) - minimum * static_cast<float>(minima[t]));
        }
    }
}
template<std::size_t Count>
STELLAN_AVX2 void q6_tile(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::fill(output.begin(), output.end(), 0.0f);
    for (std::size_t block = 0; block < input.front().size(); ++block) {
        const auto *p = row.data() + block * 210;
        __m256i accumulator[Count];
        for (std::size_t t = 0; t < Count; ++t) { accumulator[t] = _mm256_setzero_si256(); }
        for (std::size_t g = 0; g < 8; ++g) {
            const auto quarter = g % 4;
            for (std::size_t j = 0; j < 32; j += 16) {
                auto low = _mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + (g / 4) * 64 + (quarter % 2) * 32 + j)));
                if (quarter >= 2) { low = _mm256_srli_epi16(low, 4); }
                const auto high = _mm256_srl_epi16(_mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + 128 + (g / 4) * 32 + j))), _mm_cvtsi32_si128(static_cast<int>(quarter * 2)));
                const auto q = _mm256_sub_epi16(_mm256_or_si256(_mm256_and_si256(low, _mm256_set1_epi16(15)), _mm256_slli_epi16(_mm256_and_si256(high, _mm256_set1_epi16(3)), 4)), _mm256_set1_epi16(32));
                const auto raw = std::to_integer<int>(p[192 + g * 2 + j / 16]);
                const auto multiplier = _mm256_set1_epi32(raw < 128 ? raw : raw - 256);
                for (std::size_t t = 0; t < Count; ++t) {
                    const auto x = _mm256_cvtepi8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(input[t][block].values.data() + g * 32 + j)));
                    accumulator[t] = _mm256_add_epi32(accumulator[t], _mm256_mullo_epi32(_mm256_madd_epi16(q, x), multiplier));
                }
            }
        }
        const auto scale = half_float(read_half(p + 208));
        for (std::size_t t = 0; t < Count; ++t) {
            alignas(32) std::int32_t lanes[8];
            _mm256_store_si256(reinterpret_cast<__m256i *>(lanes), accumulator[t]);
            int sum = 0;
            for (const auto value : lanes) { sum += value; }
            output[t] += input[t][block].scale * scale * static_cast<float>(sum);
        }
    }
}
STELLAN_AVX2 void q4_batch(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { q4_tile<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { q4_tile<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: q4_tile<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: q4_tile<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: q4_tile<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
STELLAN_AVX2 void q6_batch(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { q6_tile<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { q6_tile<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: q6_tile<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: q6_tile<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: q6_tile<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
STELLAN_AVX2 void recurrent(std::size_t width, std::size_t states, std::span<const float> input, float dt, float decay, float skip,
        std::span<const float> b, std::span<const float> c, std::span<float> state, std::span<float> output) {
    const auto attenuation = _mm256_set1_ps(decay);
    for (std::size_t channel = 0; channel < width; ++channel) {
        const auto x = _mm256_set1_ps(dt * input[channel]);
        auto sum = _mm256_setzero_ps();
        for (std::size_t n = 0; n < states; n += 8) {
            auto *p = state.data() + channel * states + n;
            const auto next = _mm256_fmadd_ps(_mm256_loadu_ps(b.data() + n), x, _mm256_mul_ps(attenuation, _mm256_loadu_ps(p)));
            _mm256_storeu_ps(p, next);
            sum = _mm256_fmadd_ps(next, _mm256_loadu_ps(c.data() + n), sum);
        }
        alignas(32) float lanes[8];
        _mm256_store_ps(lanes, sum);
        float y = skip * input[channel];
        for (const auto value : lanes) { y += value; }
        output[channel] = y;
    }
}
}

bool accelerated_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const float> input, float &result) {
    static const bool enabled = available();
    if (!enabled || (type != 12 && type != 14)) { return false; }
    result = packed_dot(type, row, input);
    return true;
}
bool accelerated_quantized_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const QuantizedInput> input, float &result) {
    static const bool enabled = available();
    if (!enabled) { return false; }
    result = q8_dot(type, row, input);
    return true;
}
bool accelerated_quantized_batch_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    static const bool enabled = available();
    if (!enabled || (type != 12 && type != 14)) { return false; }
    if (type == 12) { q4_batch(row, input, output); }
    else { q6_batch(row, input, output); }
    return true;
}
bool accelerated_ssm(std::size_t width, std::size_t states, std::span<const float> input, float dt, float decay, float skip,
        std::span<const float> b, std::span<const float> c, std::span<float> state, std::span<float> output) {
    static const bool enabled = available();
    if (!enabled || states % 8 != 0) { return false; }
    recurrent(width, states, input, dt, decay, skip, b, c, state, output);
    return true;
}
}
#elif defined(__aarch64__) || defined(__arm64__)
#include <arm_neon.h>
namespace stellan {
bool accelerated_dot(std::uint32_t, std::span<const std::byte>, std::span<const float>, float &) { return false; }
bool accelerated_ssm(std::size_t width, std::size_t states, std::span<const float> input, float dt, float decay, float skip,
        std::span<const float> b, std::span<const float> c, std::span<float> state, std::span<float> output) {
    if (states % 4 != 0 || environment_set("STELLAN_RUNTIME_SCALAR")) { return false; }
    for (std::size_t channel = 0; channel < width; ++channel) {
        const auto x = vdupq_n_f32(dt * input[channel]);
        auto sum = vdupq_n_f32(0);
        for (std::size_t n = 0; n < states; n += 4) {
            auto *p = state.data() + channel * states + n;
            const auto next = vfmaq_f32(vmulq_n_f32(vld1q_f32(p), decay), vld1q_f32(b.data() + n), x);
            vst1q_f32(p, next);
            sum = vfmaq_f32(sum, next, vld1q_f32(c.data() + n));
        }
        output[channel] = skip * input[channel] + vaddvq_f32(sum);
    }
    return true;
}
bool accelerated_quantized_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const QuantizedInput> input, float &result) {
    if (environment_set("STELLAN_RUNTIME_SCALAR")) { return false; }
    float total = 0;
    const auto read = [](const std::byte *p) {
        const auto bits = static_cast<std::uint16_t>(std::to_integer<unsigned>(p[0]) | (std::to_integer<unsigned>(p[1]) << 8));
        return vgetq_lane_f32(vcvt_f32_f16(vreinterpret_f16_u16(vdup_n_u16(bits))), 0);
    };
    for (std::size_t b = 0; b < input.size(); ++b) {
        const auto *p = row.data() + b * (type == 12 ? 144 : 210);
        int sum = 0;
        int minima = 0;
        for (std::size_t g = 0; g < 8; ++g) {
            if (type == 12) {
                const auto *s = p + 4;
                const auto scale = g < 4 ? std::to_integer<unsigned>(s[g]) & 63U : (std::to_integer<unsigned>(s[g + 4]) & 15U) | ((std::to_integer<unsigned>(s[g - 4]) >> 6) << 4);
                const auto offset = g < 4 ? std::to_integer<unsigned>(s[g + 4]) & 63U : (std::to_integer<unsigned>(s[g + 4]) >> 4) | ((std::to_integer<unsigned>(s[g]) >> 6) << 4);
                auto dot = vdupq_n_s32(0);
                for (std::size_t j = 0; j < 32; j += 8) {
                    auto q = vld1_u8(reinterpret_cast<const std::uint8_t *>(p + 16 + (g / 2) * 32 + j));
                    if (g % 2 != 0) { q = vshr_n_u8(q, 4); }
                    q = vand_u8(q, vdup_n_u8(15));
                    dot = vpadalq_s16(dot, vmull_s8(vreinterpret_s8_u8(q), vld1_s8(input[b].values.data() + g * 32 + j)));
                }
                sum += static_cast<int>(scale) * vaddvq_s32(dot);
                minima += static_cast<int>(offset) * (input[b].sums[g * 2] + input[b].sums[g * 2 + 1]);
            } else {
                const auto quarter = g % 4;
                for (std::size_t j = 0; j < 32; j += 16) {
                    auto dot = vdupq_n_s32(0);
                    for (std::size_t k = 0; k < 16; k += 8) {
                        auto low = vld1_u8(reinterpret_cast<const std::uint8_t *>(p + (g / 4) * 64 + (quarter % 2) * 32 + j + k));
                        if (quarter >= 2) { low = vshr_n_u8(low, 4); }
                        auto high = vld1_u8(reinterpret_cast<const std::uint8_t *>(p + 128 + (g / 4) * 32 + j + k));
                        high = vshl_u8(high, vdup_n_s8(static_cast<std::int8_t>(-static_cast<int>(quarter * 2))));
                        const auto q = vsub_u8(vorr_u8(vand_u8(low, vdup_n_u8(15)), vshl_n_u8(vand_u8(high, vdup_n_u8(3)), 4)), vdup_n_u8(32));
                        dot = vpadalq_s16(dot, vmull_s8(vreinterpret_s8_u8(q), vld1_s8(input[b].values.data() + g * 32 + j + k)));
                    }
                    const auto raw = std::to_integer<int>(p[192 + g * 2 + j / 16]);
                    sum += (raw < 128 ? raw : raw - 256) * vaddvq_s32(dot);
                }
            }
        }
        total += input[b].scale * (type == 12 ? read(p) * static_cast<float>(sum) - read(p + 2) * static_cast<float>(minima) : read(p + 208) * static_cast<float>(sum));
    }
    result = total;
    return true;
}
}
#else
namespace stellan {
bool accelerated_dot(std::uint32_t, std::span<const std::byte>, std::span<const float>, float &) { return false; }
bool accelerated_quantized_dot(std::uint32_t, std::span<const std::byte>, std::span<const QuantizedInput>, float &) { return false; }
bool accelerated_ssm(std::size_t, std::size_t, std::span<const float>, float, float, float, std::span<const float>, std::span<const float>, std::span<float>, std::span<float>) { return false; }
}
#endif

#if defined(__aarch64__) || defined(__arm64__)
namespace stellan {
bool accelerated_quantized_batch_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    if (environment_set("STELLAN_RUNTIME_SCALAR")) { return false; }
    // Reuse the checked integer NEON dot path instead of scalar float reductions in prefill.
    for (std::size_t t = 0; t < input.size(); ++t) {
        if (!accelerated_quantized_dot(type, row, input[t], output[t])) { return false; }
    }
    return true;
}
}
#elif !defined(__x86_64__) && !defined(__i386__) && !defined(_M_X64)
namespace stellan {
bool accelerated_quantized_batch_dot(std::uint32_t, std::span<const std::byte>, std::span<const std::span<const QuantizedInput>>, std::span<float>) { return false; }
}
#endif
