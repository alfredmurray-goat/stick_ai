#include "runtime.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

#if defined(__x86_64__) || defined(__i386__) || defined(_M_X64)
#include <immintrin.h>
#ifdef _MSC_VER
#include <intrin.h>
// MSVC compiles every intrinsic without per-function targets; the CPU checks below decide what runs.
#define STELLAN_AVX2
#define STELLAN_HAS_VNNI 1
#define STELLAN_VNNI
#define STELLAN_VNNI512
#else
#define STELLAN_AVX2 __attribute__((target("avx2,fma,f16c")))
#include <cpuid.h>
#define STELLAN_HAS_VNNI 1
#define STELLAN_VNNI __attribute__((target("avx2,fma,f16c,avxvnni")))
#define STELLAN_VNNI512 __attribute__((target("avx2,fma,f16c,avx512f,avx512vl,avx512vnni")))
#endif

namespace stellan {
namespace {
std::uint16_t read_half(const std::byte *p) {
    return static_cast<std::uint16_t>(std::to_integer<unsigned>(p[0]) | (std::to_integer<unsigned>(p[1]) << 8));
}
bool available() {
    static const bool scalar = environment_set("STELLAN_RUNTIME_SCALAR");
    if (scalar) { return false; }
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
// minimum[g] * (sum of the activation's two 16-value sums in group g), for all eight groups at once.
STELLAN_AVX2 inline float hsum_ps(__m256 value) {
    auto sum = _mm_add_ps(_mm256_castps256_ps128(value), _mm256_extractf128_ps(value, 1));
    sum = _mm_add_ps(sum, _mm_movehl_ps(sum, sum));
    sum = _mm_add_ss(sum, _mm_movehdup_ps(sum));
    return _mm_cvtss_f32(sum);
}
// Q4_K packs 8 six-bit scales and 8 six-bit minimums into 12 bytes. Unpacked four bytes at a time:
// words[0] = scales 0-3, words[1] = scales 4-7, words[2] = minimums 0-3, words[3] = minimums 4-7.
inline void unpack_q4k(const std::byte *packed, std::uint32_t words[4]) {
    std::uint32_t w0, w1, w2;
    std::memcpy(&w0, packed, 4); std::memcpy(&w1, packed + 4, 4); std::memcpy(&w2, packed + 8, 4);
    words[0] = w0 & 0x3f3f3f3fU;
    words[1] = (w2 & 0x0f0f0f0fU) | (((w0 >> 6) & 0x03030303U) << 4);
    words[2] = w1 & 0x3f3f3f3fU;
    words[3] = ((w2 >> 4) & 0x0f0f0f0fU) | (((w1 >> 6) & 0x03030303U) << 4);
}
// The 8 minimums as 16 int16 lanes, each repeated twice (one per 16-value activation sum), built in
// registers rather than through a scratch array the CPU would have to forward from a store.
STELLAN_AVX2 inline __m256i q4k_minima_vector(const std::uint32_t words[4]) {
    const auto bytes = _mm_shuffle_epi8(_mm_set_epi32(0, 0, static_cast<int>(words[3]), static_cast<int>(words[2])), _mm_setr_epi8(0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7));
    return _mm256_cvtepu8_epi16(bytes);
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
    auto totals = _mm256_setzero_ps();
    for (std::size_t b = 0; b < input.size(); ++b) {
        const auto *p = row.data() + b * (type == 12 ? 144 : 210);
        auto accumulator = _mm256_setzero_si256();
        std::uint32_t words[4] {};
        if (type == 12) { unpack_q4k(p + 4, words); }
        for (std::size_t g = 0; g < 8; ++g) {
            if (type == 12) {
                const auto scale = (words[g / 4] >> (8 * (g % 4))) & 0xffU;
                auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 16 + (g / 2) * 32));
                if (g % 2 != 0) { q = _mm256_srli_epi16(q, 4); }
                q = _mm256_and_si256(q, _mm256_set1_epi8(15));
                const auto x = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(input[b].values.data() + g * 32));
                accumulator = _mm256_add_epi32(accumulator, _mm256_madd_epi16(_mm256_maddubs_epi16(q, x), _mm256_set1_epi16(static_cast<short>(scale))));
            } else {
                const auto quarter = g % 4;
                for (std::size_t j = 0; j < 32; j += 16) {
                    auto low = _mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + (g / 4) * 64 + (quarter % 2) * 32 + j)));
                    if (quarter >= 2) { low = _mm256_srli_epi16(low, 4); }
                    const auto high = _mm256_srl_epi16(_mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + 128 + (g / 4) * 32 + j))), _mm_cvtsi32_si128(static_cast<int>(quarter * 2)));
                    const auto q = _mm256_sub_epi16(_mm256_or_si256(_mm256_and_si256(low, _mm256_set1_epi16(15)), _mm256_slli_epi16(_mm256_and_si256(high, _mm256_set1_epi16(3)), 4)), _mm256_set1_epi16(32));
                    const auto x = _mm256_cvtepi8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(input[b].values.data() + g * 32 + j)));
                    const auto raw = std::to_integer<int>(p[192 + g * 2 + j / 16]);
                    accumulator = _mm256_add_epi32(accumulator, _mm256_madd_epi16(_mm256_mullo_epi16(q, _mm256_set1_epi16(static_cast<short>(raw < 128 ? raw : raw - 256))), x));
                }
            }
        }
        // Lane totals stay in a float vector (exact int32 -> float below 2^24); one horizontal sum per row.
        if (type == 12) {
            const auto minima = _mm256_madd_epi16(_mm256_loadu_si256(reinterpret_cast<const __m256i *>(input[b].sums.data())), q4k_minima_vector(words));
            totals = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator), _mm256_set1_ps(input[b].scale * half_float(read_half(p))), totals);
            totals = _mm256_fnmadd_ps(_mm256_cvtepi32_ps(minima), _mm256_set1_ps(input[b].scale * half_float(read_half(p + 2))), totals);
        }
        else { totals = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator), _mm256_set1_ps(input[b].scale * half_float(read_half(p + 208))), totals); }
    }
    return hsum_ps(totals);
}
template<std::size_t Count>
STELLAN_AVX2 void q4_tile(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    __m256 totals[Count];
    for (std::size_t t = 0; t < Count; ++t) { totals[t] = _mm256_setzero_ps(); }
    for (std::size_t block = 0; block < input.front().size(); ++block) {
        const auto *p = row.data() + block * 144;
        __m256i accumulator[Count];
        std::uint32_t words[4];
        unpack_q4k(p + 4, words);
        for (std::size_t t = 0; t < Count; ++t) { accumulator[t] = _mm256_setzero_si256(); }
        for (std::size_t g = 0; g < 8; ++g) {
            const auto scale = (words[g / 4] >> (8 * (g % 4))) & 0xffU;
            auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 16 + (g / 2) * 32));
            if (g % 2 != 0) { q = _mm256_srli_epi16(q, 4); }
            q = _mm256_and_si256(q, _mm256_set1_epi8(15));
            // scale <= 63 and |maddubs| <= 3810, so scale * pair sum fits int32 exactly: same integers, one instruction.
            const auto multiplier = _mm256_set1_epi16(static_cast<short>(scale));
            for (std::size_t t = 0; t < Count; ++t) {
                const auto &x = input[t][block];
                const auto values = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(x.values.data() + g * 32));
                accumulator[t] = _mm256_add_epi32(accumulator[t], _mm256_madd_epi16(_mm256_maddubs_epi16(q, values), multiplier));
            }
        }
        const auto scale = half_float(read_half(p));
        const auto minimum = half_float(read_half(p + 2));
        const auto minima_vector = q4k_minima_vector(words);
        // Keep per-lane float totals and sum lanes once per row: each lane's int32 total is below 2^24, so
        // the conversion is exact, and two horizontal sums per token per block disappear.
        for (std::size_t t = 0; t < Count; ++t) {
            const auto &x = input[t][block];
            const auto minima = _mm256_madd_epi16(_mm256_loadu_si256(reinterpret_cast<const __m256i *>(x.sums.data())), minima_vector);
            totals[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator[t]), _mm256_set1_ps(x.scale * scale), totals[t]);
            totals[t] = _mm256_fnmadd_ps(_mm256_cvtepi32_ps(minima), _mm256_set1_ps(x.scale * minimum), totals[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(totals[t]); }
}
template<std::size_t Count>
STELLAN_AVX2 void q6_tile(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    __m256 totals[Count];
    for (std::size_t t = 0; t < Count; ++t) { totals[t] = _mm256_setzero_ps(); }
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
                // |q| <= 32 and |scale| <= 128, so q * scale fits int16; one multiply per group instead of one per token.
                const auto scaled = _mm256_mullo_epi16(q, _mm256_set1_epi16(static_cast<short>(raw < 128 ? raw : raw - 256)));
                for (std::size_t t = 0; t < Count; ++t) {
                    const auto x = _mm256_cvtepi8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(input[t][block].values.data() + g * 32 + j)));
                    accumulator[t] = _mm256_add_epi32(accumulator[t], _mm256_madd_epi16(scaled, x));
                }
            }
        }
        const auto scale = half_float(read_half(p + 208));
        for (std::size_t t = 0; t < Count; ++t) {
            totals[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator[t]), _mm256_set1_ps(input[t][block].scale * scale), totals[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(totals[t]); }
}
// Q8_0 weights (32 int8 values and one f16 scale per block) against int8 activations. abs(weight) times
// sign-adjusted activation keeps maddubs's unsigned-by-signed form; 128 * 127 * 2 still fits int16.
template<std::size_t Count>
STELLAN_AVX2 void q8_0_tile(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    __m256 sums[Count];
    for (std::size_t t = 0; t < Count; ++t) { sums[t] = _mm256_setzero_ps(); }
    const auto ones = _mm256_set1_epi16(1);
    for (std::size_t block = 0; block < input.front().size(); ++block) {
        // The weight scale changes every 32 values but the activation scale only every 256, so apply the
        // weight scale in the loop and the activation scale once per block.
        __m256 partial[Count];
        for (std::size_t t = 0; t < Count; ++t) { partial[t] = _mm256_setzero_ps(); }
        for (std::size_t g = 0; g < 8; ++g) {
            const auto *p = row.data() + (block * 8 + g) * 34;
            const auto weights = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 2));
            const auto magnitude = _mm256_sign_epi8(weights, weights);
            const auto scale = _mm256_set1_ps(half_float(read_half(p)));
            for (std::size_t t = 0; t < Count; ++t) {
                const auto values = _mm256_sign_epi8(_mm256_loadu_si256(reinterpret_cast<const __m256i *>(input[t][block].values.data() + g * 32)), weights);
                const auto products = _mm256_madd_epi16(_mm256_maddubs_epi16(magnitude, values), ones);
                partial[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(products), scale, partial[t]);
            }
        }
        for (std::size_t t = 0; t < Count; ++t) { sums[t] = _mm256_fmadd_ps(partial[t], _mm256_set1_ps(input[t][block].scale), sums[t]); }
    }
    for (std::size_t t = 0; t < Count; ++t) {
        auto half_sum = _mm_add_ps(_mm256_castps256_ps128(sums[t]), _mm256_extractf128_ps(sums[t], 1));
        half_sum = _mm_add_ps(half_sum, _mm_movehl_ps(half_sum, half_sum));
        half_sum = _mm_add_ss(half_sum, _mm_movehdup_ps(half_sum));
        output[t] = _mm_cvtss_f32(half_sum);
    }
}
template<std::size_t Count>
STELLAN_AVX2 void fine_tile(std::span<const std::byte> row, std::span<const std::span<const FineInput>> input, std::span<float> output) {
    __m256 sums[Count];
    for (std::size_t t = 0; t < Count; ++t) { sums[t] = _mm256_setzero_ps(); }
    const auto ones = _mm256_set1_epi16(1);
    for (std::size_t g = 0; g < input.front().size(); ++g) {
        const auto *p = row.data() + g * 34;
        const auto weights = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 2));
        const auto magnitude = _mm256_sign_epi8(weights, weights);
        const auto scale = half_float(read_half(p));
        for (std::size_t t = 0; t < Count; ++t) {
            const auto &x = input[t][g];
            const auto values = _mm256_sign_epi8(_mm256_load_si256(reinterpret_cast<const __m256i *>(x.values.data())), weights);
            const auto products = _mm256_madd_epi16(_mm256_maddubs_epi16(magnitude, values), ones);
            sums[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(products), _mm256_set1_ps(scale * x.scale), sums[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(sums[t]); }
}
STELLAN_AVX2 void fine_batch(std::span<const std::byte> row, std::span<const std::span<const FineInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { fine_tile<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { fine_tile<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: fine_tile<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: fine_tile<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: fine_tile<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
STELLAN_AVX2 void q8_0_batch(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { q8_0_tile<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { q8_0_tile<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: q8_0_tile<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: q8_0_tile<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: q8_0_tile<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
// exp for x <= 0 (attention scores after subtracting the maximum): Cephes-style range reduction and
// a degree-5 polynomial, accurate to a few float ulps.
STELLAN_AVX2 inline __m256 exp_ps(__m256 x) {
    x = _mm256_max_ps(x, _mm256_set1_ps(-87.0F));
    auto fx = _mm256_floor_ps(_mm256_fmadd_ps(x, _mm256_set1_ps(1.44269504088896341F), _mm256_set1_ps(0.5F)));
    x = _mm256_fnmadd_ps(fx, _mm256_set1_ps(0.693359375F), x);
    x = _mm256_fnmadd_ps(fx, _mm256_set1_ps(-2.12194440e-4F), x);
    auto y = _mm256_set1_ps(1.9875691500e-4F);
    y = _mm256_fmadd_ps(y, x, _mm256_set1_ps(1.3981999507e-3F));
    y = _mm256_fmadd_ps(y, x, _mm256_set1_ps(8.3334519073e-3F));
    y = _mm256_fmadd_ps(y, x, _mm256_set1_ps(4.1665795894e-2F));
    y = _mm256_fmadd_ps(y, x, _mm256_set1_ps(1.6666665459e-1F));
    y = _mm256_fmadd_ps(y, x, _mm256_set1_ps(5.0000001201e-1F));
    y = _mm256_fmadd_ps(y, _mm256_mul_ps(x, x), _mm256_add_ps(x, _mm256_set1_ps(1.0F)));
    const auto power = _mm256_slli_epi32(_mm256_add_epi32(_mm256_cvttps_epi32(fx), _mm256_set1_epi32(127)), 23);
    return _mm256_mul_ps(y, _mm256_castsi256_ps(power));
}
// One query of one head against every key (no mask): scores, softmax and the weighted sum of values.
STELLAN_AVX2 void attention_row(std::size_t tokens, std::size_t dim, std::size_t stride, const float *q, const float *keys, const float *values, float scale, float *scores, float *out) {
    const auto lanes = dim / 8;
    __m256 query[16];
    for (std::size_t i = 0; i < lanes; ++i) { query[i] = _mm256_mul_ps(_mm256_loadu_ps(q + i * 8), _mm256_set1_ps(scale)); }
    std::size_t j = 0;
    for (; j + 4 <= tokens; j += 4) {
        auto a0 = _mm256_setzero_ps(), a1 = _mm256_setzero_ps(), a2 = _mm256_setzero_ps(), a3 = _mm256_setzero_ps();
        const auto *k = keys + j * stride;
        for (std::size_t i = 0; i < lanes; ++i) {
            a0 = _mm256_fmadd_ps(query[i], _mm256_loadu_ps(k + i * 8), a0);
            a1 = _mm256_fmadd_ps(query[i], _mm256_loadu_ps(k + stride + i * 8), a1);
            a2 = _mm256_fmadd_ps(query[i], _mm256_loadu_ps(k + 2 * stride + i * 8), a2);
            a3 = _mm256_fmadd_ps(query[i], _mm256_loadu_ps(k + 3 * stride + i * 8), a3);
        }
        const auto h = _mm256_hadd_ps(_mm256_hadd_ps(a0, a1), _mm256_hadd_ps(a2, a3));
        _mm_storeu_ps(scores + j, _mm_add_ps(_mm256_castps256_ps128(h), _mm256_extractf128_ps(h, 1)));
    }
    for (; j < tokens; ++j) {
        auto a = _mm256_setzero_ps();
        for (std::size_t i = 0; i < lanes; ++i) { a = _mm256_fmadd_ps(query[i], _mm256_loadu_ps(keys + j * stride + i * 8), a); }
        scores[j] = hsum_ps(a);
    }
    auto top = _mm256_set1_ps(-INFINITY);
    j = 0;
    for (; j + 8 <= tokens; j += 8) { top = _mm256_max_ps(top, _mm256_loadu_ps(scores + j)); }
    alignas(32) float tops[8];
    _mm256_store_ps(tops, top);
    float maximum = *std::max_element(tops, tops + 8);
    for (; j < tokens; ++j) { maximum = std::max(maximum, scores[j]); }
    auto total = _mm256_setzero_ps();
    float tail = 0;
    j = 0;
    for (; j + 8 <= tokens; j += 8) {
        const auto e = exp_ps(_mm256_sub_ps(_mm256_loadu_ps(scores + j), _mm256_set1_ps(maximum)));
        _mm256_storeu_ps(scores + j, e); total = _mm256_add_ps(total, e);
    }
    for (; j < tokens; ++j) { scores[j] = std::exp(scores[j] - maximum); tail += scores[j]; }
    const auto inverse = 1.0F / (hsum_ps(total) + tail);
    __m256 sum[16];
    for (std::size_t i = 0; i < lanes; ++i) { sum[i] = _mm256_setzero_ps(); }
    for (j = 0; j < tokens; ++j) {
        const auto weight = _mm256_set1_ps(scores[j]);
        const auto *v = values + j * stride;
        for (std::size_t i = 0; i < lanes; ++i) { sum[i] = _mm256_fmadd_ps(weight, _mm256_loadu_ps(v + i * 8), sum[i]); }
    }
    for (std::size_t i = 0; i < lanes; ++i) { _mm256_storeu_ps(out + i * 8, _mm256_mul_ps(sum[i], _mm256_set1_ps(inverse))); }
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
// One channel's recurrence across a whole prefill batch. Half of the state (64 values) stays in eight
// registers while every token passes through it, instead of loading and storing the state per token.
// The arithmetic and its order match recurrent() exactly, so results are bit-identical.
STELLAN_AVX2 void recurrent_tokens(std::size_t states, std::size_t tokens, const float *input, const float *dt, const float *attenuation,
        const float *const *b, const float *const *c, float skip, float *state, float *output) {
    __m256 sums[prefill_batch_limit];
    for (std::size_t t = 0; t < tokens; ++t) { sums[t] = _mm256_setzero_ps(); }
    for (std::size_t base = 0; base < states; base += 64) {
        __m256 s[8];
        for (std::size_t k = 0; k < 8; ++k) { s[k] = _mm256_loadu_ps(state + base + k * 8); }
        for (std::size_t t = 0; t < tokens; ++t) {
            const auto a = _mm256_set1_ps(attenuation[t]);
            const auto x = _mm256_set1_ps(dt[t] * input[t]);
            auto sum = sums[t];
            for (std::size_t k = 0; k < 8; ++k) {
                s[k] = _mm256_fmadd_ps(_mm256_loadu_ps(b[t] + base + k * 8), x, _mm256_mul_ps(a, s[k]));
                sum = _mm256_fmadd_ps(s[k], _mm256_loadu_ps(c[t] + base + k * 8), sum);
            }
            sums[t] = sum;
        }
        for (std::size_t k = 0; k < 8; ++k) { _mm256_storeu_ps(state + base + k * 8, s[k]); }
    }
    for (std::size_t t = 0; t < tokens; ++t) {
        alignas(32) float lanes[8];
        _mm256_store_ps(lanes, sums[t]);
        float y = skip * input[t];
        for (const auto value : lanes) { y += value; }
        output[t] = y;
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

#ifdef STELLAN_HAS_VNNI
// The same kernels with VNNI: vpdpwssd/vpdpbusd multiply pairs (or quads) and add to the running int32
// sum in one instruction. Products and sums are identical to the AVX2 versions (no saturation is reached),
// so results are bit-for-bit the same; only the instruction count drops.
STELLAN_VNNI float q8_dot_vnni(std::uint32_t type, std::span<const std::byte> row, std::span<const QuantizedInput> input) {
    auto totals = _mm256_setzero_ps();
    for (std::size_t b = 0; b < input.size(); ++b) {
        const auto *p = row.data() + b * (type == 12 ? 144 : 210);
        auto accumulator = _mm256_setzero_si256();
        std::uint32_t words[4] {};
        if (type == 12) { unpack_q4k(p + 4, words); }
        for (std::size_t g = 0; g < 8; ++g) {
            if (type == 12) {
                const auto scale = (words[g / 4] >> (8 * (g % 4))) & 0xffU;
                auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 16 + (g / 2) * 32));
                if (g % 2 != 0) { q = _mm256_srli_epi16(q, 4); }
                q = _mm256_and_si256(q, _mm256_set1_epi8(15));
                const auto x = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(input[b].values.data() + g * 32));
                accumulator = _mm256_dpwssd_avx_epi32(accumulator, _mm256_maddubs_epi16(q, x), _mm256_set1_epi16(static_cast<short>(scale)));
            } else {
                const auto quarter = g % 4;
                for (std::size_t j = 0; j < 32; j += 16) {
                    auto low = _mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + (g / 4) * 64 + (quarter % 2) * 32 + j)));
                    if (quarter >= 2) { low = _mm256_srli_epi16(low, 4); }
                    const auto high = _mm256_srl_epi16(_mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + 128 + (g / 4) * 32 + j))), _mm_cvtsi32_si128(static_cast<int>(quarter * 2)));
                    const auto q = _mm256_sub_epi16(_mm256_or_si256(_mm256_and_si256(low, _mm256_set1_epi16(15)), _mm256_slli_epi16(_mm256_and_si256(high, _mm256_set1_epi16(3)), 4)), _mm256_set1_epi16(32));
                    const auto x = _mm256_cvtepi8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(input[b].values.data() + g * 32 + j)));
                    const auto raw = std::to_integer<int>(p[192 + g * 2 + j / 16]);
                    accumulator = _mm256_dpwssd_avx_epi32(accumulator, _mm256_mullo_epi16(q, _mm256_set1_epi16(static_cast<short>(raw < 128 ? raw : raw - 256))), x);
                }
            }
        }
        // Lane totals stay in a float vector (exact int32 -> float below 2^24); one horizontal sum per row.
        if (type == 12) {
            const auto minima = _mm256_madd_epi16(_mm256_loadu_si256(reinterpret_cast<const __m256i *>(input[b].sums.data())), q4k_minima_vector(words));
            totals = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator), _mm256_set1_ps(input[b].scale * half_float(read_half(p))), totals);
            totals = _mm256_fnmadd_ps(_mm256_cvtepi32_ps(minima), _mm256_set1_ps(input[b].scale * half_float(read_half(p + 2))), totals);
        }
        else { totals = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator), _mm256_set1_ps(input[b].scale * half_float(read_half(p + 208))), totals); }
    }
    return hsum_ps(totals);
}
template<std::size_t Count>
STELLAN_VNNI void q4_tile_vnni(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    __m256 totals[Count];
    for (std::size_t t = 0; t < Count; ++t) { totals[t] = _mm256_setzero_ps(); }
    for (std::size_t block = 0; block < input.front().size(); ++block) {
        const auto *p = row.data() + block * 144;
        __m256i accumulator[Count];
        std::uint32_t words[4];
        unpack_q4k(p + 4, words);
        for (std::size_t t = 0; t < Count; ++t) { accumulator[t] = _mm256_setzero_si256(); }
        for (std::size_t g = 0; g < 8; ++g) {
            const auto scale = (words[g / 4] >> (8 * (g % 4))) & 0xffU;
            auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 16 + (g / 2) * 32));
            if (g % 2 != 0) { q = _mm256_srli_epi16(q, 4); }
            q = _mm256_and_si256(q, _mm256_set1_epi8(15));
            // scale <= 63 and |maddubs| <= 3810, so scale * pair sum fits int32 exactly: same integers, one instruction.
            const auto multiplier = _mm256_set1_epi16(static_cast<short>(scale));
            for (std::size_t t = 0; t < Count; ++t) {
                const auto &x = input[t][block];
                const auto values = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(x.values.data() + g * 32));
                accumulator[t] = _mm256_dpwssd_avx_epi32(accumulator[t], _mm256_maddubs_epi16(q, values), multiplier);
            }
        }
        const auto scale = half_float(read_half(p));
        const auto minimum = half_float(read_half(p + 2));
        const auto minima_vector = q4k_minima_vector(words);
        // Keep per-lane float totals and sum lanes once per row: each lane's int32 total is below 2^24, so
        // the conversion is exact, and two horizontal sums per token per block disappear.
        for (std::size_t t = 0; t < Count; ++t) {
            const auto &x = input[t][block];
            const auto minima = _mm256_madd_epi16(_mm256_loadu_si256(reinterpret_cast<const __m256i *>(x.sums.data())), minima_vector);
            totals[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator[t]), _mm256_set1_ps(x.scale * scale), totals[t]);
            totals[t] = _mm256_fnmadd_ps(_mm256_cvtepi32_ps(minima), _mm256_set1_ps(x.scale * minimum), totals[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(totals[t]); }
}
template<std::size_t Count>
STELLAN_VNNI void q6_tile_vnni(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    __m256 totals[Count];
    for (std::size_t t = 0; t < Count; ++t) { totals[t] = _mm256_setzero_ps(); }
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
                // |q| <= 32 and |scale| <= 128, so q * scale fits int16; one multiply per group instead of one per token.
                const auto scaled = _mm256_mullo_epi16(q, _mm256_set1_epi16(static_cast<short>(raw < 128 ? raw : raw - 256)));
                for (std::size_t t = 0; t < Count; ++t) {
                    const auto x = _mm256_cvtepi8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(input[t][block].values.data() + g * 32 + j)));
                    accumulator[t] = _mm256_dpwssd_avx_epi32(accumulator[t], scaled, x);
                }
            }
        }
        const auto scale = half_float(read_half(p + 208));
        for (std::size_t t = 0; t < Count; ++t) {
            totals[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator[t]), _mm256_set1_ps(input[t][block].scale * scale), totals[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(totals[t]); }
}
template<std::size_t Count>
STELLAN_VNNI void fine_tile_vnni(std::span<const std::byte> row, std::span<const std::span<const FineInput>> input, std::span<float> output) {
    __m256 sums[Count];
    for (std::size_t t = 0; t < Count; ++t) { sums[t] = _mm256_setzero_ps(); }
    for (std::size_t g = 0; g < input.front().size(); ++g) {
        const auto *p = row.data() + g * 34;
        const auto weights = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 2));
        const auto magnitude = _mm256_sign_epi8(weights, weights);
        const auto scale = half_float(read_half(p));
        for (std::size_t t = 0; t < Count; ++t) {
            const auto &x = input[t][g];
            const auto values = _mm256_sign_epi8(_mm256_load_si256(reinterpret_cast<const __m256i *>(x.values.data())), weights);
            const auto products = _mm256_dpbusd_avx_epi32(_mm256_setzero_si256(), magnitude, values);
            sums[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(products), _mm256_set1_ps(scale * x.scale), sums[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(sums[t]); }
}
STELLAN_VNNI void q4_batch_vnni(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { q4_tile_vnni<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { q4_tile_vnni<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: q4_tile_vnni<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: q4_tile_vnni<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: q4_tile_vnni<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
STELLAN_VNNI void q6_batch_vnni(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { q6_tile_vnni<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { q6_tile_vnni<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: q6_tile_vnni<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: q6_tile_vnni<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: q6_tile_vnni<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
STELLAN_VNNI void fine_batch_vnni(std::span<const std::byte> row, std::span<const std::span<const FineInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { fine_tile_vnni<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { fine_tile_vnni<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: fine_tile_vnni<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: fine_tile_vnni<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: fine_tile_vnni<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
STELLAN_VNNI512 float q8_dot_vnni512(std::uint32_t type, std::span<const std::byte> row, std::span<const QuantizedInput> input) {
    auto totals = _mm256_setzero_ps();
    for (std::size_t b = 0; b < input.size(); ++b) {
        const auto *p = row.data() + b * (type == 12 ? 144 : 210);
        auto accumulator = _mm256_setzero_si256();
        std::uint32_t words[4] {};
        if (type == 12) { unpack_q4k(p + 4, words); }
        for (std::size_t g = 0; g < 8; ++g) {
            if (type == 12) {
                const auto scale = (words[g / 4] >> (8 * (g % 4))) & 0xffU;
                auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 16 + (g / 2) * 32));
                if (g % 2 != 0) { q = _mm256_srli_epi16(q, 4); }
                q = _mm256_and_si256(q, _mm256_set1_epi8(15));
                const auto x = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(input[b].values.data() + g * 32));
                accumulator = _mm256_dpwssd_epi32(accumulator, _mm256_maddubs_epi16(q, x), _mm256_set1_epi16(static_cast<short>(scale)));
            } else {
                const auto quarter = g % 4;
                for (std::size_t j = 0; j < 32; j += 16) {
                    auto low = _mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + (g / 4) * 64 + (quarter % 2) * 32 + j)));
                    if (quarter >= 2) { low = _mm256_srli_epi16(low, 4); }
                    const auto high = _mm256_srl_epi16(_mm256_cvtepu8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(p + 128 + (g / 4) * 32 + j))), _mm_cvtsi32_si128(static_cast<int>(quarter * 2)));
                    const auto q = _mm256_sub_epi16(_mm256_or_si256(_mm256_and_si256(low, _mm256_set1_epi16(15)), _mm256_slli_epi16(_mm256_and_si256(high, _mm256_set1_epi16(3)), 4)), _mm256_set1_epi16(32));
                    const auto x = _mm256_cvtepi8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(input[b].values.data() + g * 32 + j)));
                    const auto raw = std::to_integer<int>(p[192 + g * 2 + j / 16]);
                    accumulator = _mm256_dpwssd_epi32(accumulator, _mm256_mullo_epi16(q, _mm256_set1_epi16(static_cast<short>(raw < 128 ? raw : raw - 256))), x);
                }
            }
        }
        // Lane totals stay in a float vector (exact int32 -> float below 2^24); one horizontal sum per row.
        if (type == 12) {
            const auto minima = _mm256_madd_epi16(_mm256_loadu_si256(reinterpret_cast<const __m256i *>(input[b].sums.data())), q4k_minima_vector(words));
            totals = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator), _mm256_set1_ps(input[b].scale * half_float(read_half(p))), totals);
            totals = _mm256_fnmadd_ps(_mm256_cvtepi32_ps(minima), _mm256_set1_ps(input[b].scale * half_float(read_half(p + 2))), totals);
        }
        else { totals = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator), _mm256_set1_ps(input[b].scale * half_float(read_half(p + 208))), totals); }
    }
    return hsum_ps(totals);
}
template<std::size_t Count>
STELLAN_VNNI512 void q4_tile_vnni512(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    __m256 totals[Count];
    for (std::size_t t = 0; t < Count; ++t) { totals[t] = _mm256_setzero_ps(); }
    for (std::size_t block = 0; block < input.front().size(); ++block) {
        const auto *p = row.data() + block * 144;
        __m256i accumulator[Count];
        std::uint32_t words[4];
        unpack_q4k(p + 4, words);
        for (std::size_t t = 0; t < Count; ++t) { accumulator[t] = _mm256_setzero_si256(); }
        for (std::size_t g = 0; g < 8; ++g) {
            const auto scale = (words[g / 4] >> (8 * (g % 4))) & 0xffU;
            auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 16 + (g / 2) * 32));
            if (g % 2 != 0) { q = _mm256_srli_epi16(q, 4); }
            q = _mm256_and_si256(q, _mm256_set1_epi8(15));
            // scale <= 63 and |maddubs| <= 3810, so scale * pair sum fits int32 exactly: same integers, one instruction.
            const auto multiplier = _mm256_set1_epi16(static_cast<short>(scale));
            for (std::size_t t = 0; t < Count; ++t) {
                const auto &x = input[t][block];
                const auto values = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(x.values.data() + g * 32));
                accumulator[t] = _mm256_dpwssd_epi32(accumulator[t], _mm256_maddubs_epi16(q, values), multiplier);
            }
        }
        const auto scale = half_float(read_half(p));
        const auto minimum = half_float(read_half(p + 2));
        const auto minima_vector = q4k_minima_vector(words);
        // Keep per-lane float totals and sum lanes once per row: each lane's int32 total is below 2^24, so
        // the conversion is exact, and two horizontal sums per token per block disappear.
        for (std::size_t t = 0; t < Count; ++t) {
            const auto &x = input[t][block];
            const auto minima = _mm256_madd_epi16(_mm256_loadu_si256(reinterpret_cast<const __m256i *>(x.sums.data())), minima_vector);
            totals[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator[t]), _mm256_set1_ps(x.scale * scale), totals[t]);
            totals[t] = _mm256_fnmadd_ps(_mm256_cvtepi32_ps(minima), _mm256_set1_ps(x.scale * minimum), totals[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(totals[t]); }
}
template<std::size_t Count>
STELLAN_VNNI512 void q6_tile_vnni512(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    __m256 totals[Count];
    for (std::size_t t = 0; t < Count; ++t) { totals[t] = _mm256_setzero_ps(); }
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
                // |q| <= 32 and |scale| <= 128, so q * scale fits int16; one multiply per group instead of one per token.
                const auto scaled = _mm256_mullo_epi16(q, _mm256_set1_epi16(static_cast<short>(raw < 128 ? raw : raw - 256)));
                for (std::size_t t = 0; t < Count; ++t) {
                    const auto x = _mm256_cvtepi8_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i *>(input[t][block].values.data() + g * 32 + j)));
                    accumulator[t] = _mm256_dpwssd_epi32(accumulator[t], scaled, x);
                }
            }
        }
        const auto scale = half_float(read_half(p + 208));
        for (std::size_t t = 0; t < Count; ++t) {
            totals[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(accumulator[t]), _mm256_set1_ps(input[t][block].scale * scale), totals[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(totals[t]); }
}
template<std::size_t Count>
STELLAN_VNNI512 void fine_tile_vnni512(std::span<const std::byte> row, std::span<const std::span<const FineInput>> input, std::span<float> output) {
    __m256 sums[Count];
    for (std::size_t t = 0; t < Count; ++t) { sums[t] = _mm256_setzero_ps(); }
    for (std::size_t g = 0; g < input.front().size(); ++g) {
        const auto *p = row.data() + g * 34;
        const auto weights = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(p + 2));
        const auto magnitude = _mm256_sign_epi8(weights, weights);
        const auto scale = half_float(read_half(p));
        for (std::size_t t = 0; t < Count; ++t) {
            const auto &x = input[t][g];
            const auto values = _mm256_sign_epi8(_mm256_load_si256(reinterpret_cast<const __m256i *>(x.values.data())), weights);
            const auto products = _mm256_dpbusd_epi32(_mm256_setzero_si256(), magnitude, values);
            sums[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(products), _mm256_set1_ps(scale * x.scale), sums[t]);
        }
    }
    for (std::size_t t = 0; t < Count; ++t) { output[t] = hsum_ps(sums[t]); }
}
STELLAN_VNNI512 void q4_batch_vnni512(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { q4_tile_vnni512<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { q4_tile_vnni512<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: q4_tile_vnni512<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: q4_tile_vnni512<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: q4_tile_vnni512<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
STELLAN_VNNI512 void q6_batch_vnni512(std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { q6_tile_vnni512<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { q6_tile_vnni512<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: q6_tile_vnni512<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: q6_tile_vnni512<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: q6_tile_vnni512<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
STELLAN_VNNI512 void fine_batch_vnni512(std::span<const std::byte> row, std::span<const std::span<const FineInput>> input, std::span<float> output) {
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) { fine_tile_vnni512<8>(row, input.subspan(first, 8), output.subspan(first, 8)); }
    if (first + 4 <= input.size()) { fine_tile_vnni512<4>(row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: fine_tile_vnni512<3>(row, input.subspan(first), output.subspan(first)); break;
        case 2: fine_tile_vnni512<2>(row, input.subspan(first), output.subspan(first)); break;
        case 1: fine_tile_vnni512<1>(row, input.subspan(first), output.subspan(first)); break;
        default: break;
    }
}
#endif
namespace {
// AVX-VNNI (Intel 12th gen and later, AMD Zen 5) or AVX512-VNNI with VL (Intel Ice Lake/Tiger Lake and
// later server/laptop parts, AMD Zen 4). STELLAN_RUNTIME_NO_VNNI keeps the AVX2 kernels for comparison.
enum class Vnni { none, avx, avx512 };
Vnni vnni() {
#ifdef STELLAN_HAS_VNNI
    static const Vnni level = [] {
        if (environment_set("STELLAN_RUNTIME_NO_VNNI") || !available()) { return Vnni::none; }
        unsigned a = 0, b = 0, c = 0, d = 0;
#ifdef _MSC_VER
        int registers[4];
        __cpuidex(registers, 7, 1);
        if ((static_cast<unsigned>(registers[0]) & (1U << 4)) != 0) { return Vnni::avx; }
        __cpuidex(registers, 7, 0);
        b = static_cast<unsigned>(registers[1]); c = static_cast<unsigned>(registers[2]);
        // AVX-512 state must also be enabled by the operating system (XCR0 opmask and upper ZMM bits).
        if ((c & (1U << 11)) != 0 && (b & (1U << 31)) != 0 && (b & (1U << 16)) != 0 && (_xgetbv(0) & 0xE6) == 0xE6) { return Vnni::avx512; }
        (void)a; (void)d;
#else
        if (__get_cpuid_count(7, 1, &a, &b, &c, &d) && (a & (1U << 4)) != 0) { return Vnni::avx; }
        if (__get_cpuid_count(7, 0, &a, &b, &c, &d) && (c & (1U << 11)) != 0 && (b & (1U << 31)) != 0 && (b & (1U << 16)) != 0) {
            // AVX-512 state must also be enabled by the operating system (XCR0 opmask and upper ZMM bits).
            unsigned low = 0, high = 0;
            __asm__("xgetbv" : "=a"(low), "=d"(high) : "c"(0));
            if ((low & 0xE6) == 0xE6) { return Vnni::avx512; }
        }
#endif
        return Vnni::none;
    }();
    return level;
#else
    return Vnni::none;
#endif
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
#ifdef STELLAN_HAS_VNNI
    if (vnni() == Vnni::avx) { result = q8_dot_vnni(type, row, input); return true; }
    if (vnni() == Vnni::avx512) { result = q8_dot_vnni512(type, row, input); return true; }
#endif
    result = q8_dot(type, row, input);
    return true;
}
bool accelerated_quantized_batch_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    static const bool enabled = available();
    if (!enabled || (type != 8 && type != 12 && type != 14)) { return false; }
    if (type == 8) { q8_0_batch(row, input, output); return true; }
#ifdef STELLAN_HAS_VNNI
    if (vnni() == Vnni::avx) { if (type == 12) { q4_batch_vnni(row, input, output); } else { q6_batch_vnni(row, input, output); } return true; }
    if (vnni() == Vnni::avx512) { if (type == 12) { q4_batch_vnni512(row, input, output); } else { q6_batch_vnni512(row, input, output); } return true; }
#endif
    if (type == 12) { q4_batch(row, input, output); }
    else { q6_batch(row, input, output); }
    return true;
}
bool accelerated_fine_batch_dot(std::span<const std::byte> row, std::span<const std::span<const FineInput>> input, std::span<float> output) {
    static const bool enabled = available();
    if (!enabled) { return false; }
#ifdef STELLAN_HAS_VNNI
    if (vnni() == Vnni::avx) { fine_batch_vnni(row, input, output); return true; }
    if (vnni() == Vnni::avx512) { fine_batch_vnni512(row, input, output); return true; }
#endif
    fine_batch(row, input, output);
    return true;
}
// Q4_K rows interleaved 8 at a time (see interleave_q4k in runtime.hpp). With rows side by side, one VNNI
// dpbusd multiplies 4 weights of each of 8 rows by the same 4 activation bytes: one instruction per 32
// products instead of maddubs + dpwssd per row, and the per-group scales apply once per 8 rows.
namespace {
struct Q4kBlock8 { float d[8], dmin[8]; std::uint8_t scale[8][8], minimum[8][8]; std::uint8_t q[8][4][32]; };
static_assert(sizeof(Q4kBlock8) == q4k_interleaved_block_bytes);
#ifdef STELLAN_HAS_VNNI
#define STELLAN_INTERLEAVED_TILE(NAME, TARGET, DPBUSD) \
template<int T> TARGET void NAME(const Q4kBlock8 *w, std::size_t blocks, const QuantizedInput *const *x, float *out, std::size_t out_stride) { \
    __m256 total[T]; \
    for (int t = 0; t < T; ++t) { total[t] = _mm256_setzero_ps(); } \
    const auto mask = _mm256_set1_epi8(15); \
    for (std::size_t b = 0; b < blocks; ++b) { \
        const auto &blk = w[b]; \
        const auto d = _mm256_loadu_ps(blk.d), dmin = _mm256_loadu_ps(blk.dmin); \
        __m256 sum[T], mins[T]; \
        for (int t = 0; t < T; ++t) { sum[t] = _mm256_setzero_ps(); mins[t] = _mm256_setzero_ps(); } \
        for (int g = 0; g < 8; ++g) { \
            const auto scale = _mm256_mul_ps(_mm256_cvtepi32_ps(_mm256_cvtepu8_epi32(_mm_loadl_epi64(reinterpret_cast<const __m128i *>(blk.scale[g])))), d); \
            const auto minimum = _mm256_mul_ps(_mm256_cvtepi32_ps(_mm256_cvtepu8_epi32(_mm_loadl_epi64(reinterpret_cast<const __m128i *>(blk.minimum[g])))), dmin); \
            __m256i acc[T]; \
            for (int t = 0; t < T; ++t) { acc[t] = _mm256_setzero_si256(); } \
            for (int s = 0; s < 4; ++s) { \
                const auto q = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(blk.q[g][s])); \
                const auto lo = _mm256_and_si256(q, mask), hi = _mm256_and_si256(_mm256_srli_epi16(q, 4), mask); \
                for (int t = 0; t < T; ++t) { \
                    std::int32_t a, c; \
                    std::memcpy(&a, x[t][b].values.data() + g * 32 + 4 * s, 4); \
                    std::memcpy(&c, x[t][b].values.data() + g * 32 + 16 + 4 * s, 4); \
                    acc[t] = DPBUSD(acc[t], lo, _mm256_set1_epi32(a)); \
                    acc[t] = DPBUSD(acc[t], hi, _mm256_set1_epi32(c)); \
                } \
            } \
            for (int t = 0; t < T; ++t) { \
                /*  Each int32 total is below 2^24 (32 products of at most 15 * 127), so the conversion is exact. */ \
                sum[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(acc[t]), scale, sum[t]); \
                mins[t] = _mm256_fmadd_ps(minimum, _mm256_set1_ps(static_cast<float>(x[t][b].sums[2 * g] + x[t][b].sums[2 * g + 1])), mins[t]); \
            } \
        } \
        for (int t = 0; t < T; ++t) { total[t] = _mm256_fmadd_ps(_mm256_sub_ps(sum[t], mins[t]), _mm256_set1_ps(x[t][b].scale), total[t]); } \
    } \
    for (int t = 0; t < T; ++t) { _mm256_storeu_ps(out + t * out_stride, total[t]); } \
}
STELLAN_INTERLEAVED_TILE(interleaved_tile_vnni, STELLAN_VNNI, _mm256_dpbusd_avx_epi32)
STELLAN_INTERLEAVED_TILE(interleaved_tile_vnni512, STELLAN_VNNI512, _mm256_dpbusd_epi32)
#undef STELLAN_INTERLEAVED_TILE
template<bool Wide>
void interleaved_batch(const Q4kBlock8 *w, std::size_t blocks, std::span<const std::span<const QuantizedInput>> input, float *out, std::size_t stride) {
    const QuantizedInput *x[prefill_batch_limit];
    for (std::size_t t = 0; t < input.size(); ++t) { x[t] = input[t].data(); }
    std::size_t t = 0;
    const auto run = [&]<int T>() { if constexpr (Wide) { interleaved_tile_vnni512<T>(w, blocks, x + t, out + t * stride, stride); } else { interleaved_tile_vnni<T>(w, blocks, x + t, out + t * stride, stride); } t += T; };
    while (t + 4 <= input.size()) { run.template operator()<4>(); }
    switch (input.size() - t) {
        case 3: run.template operator()<3>(); break;
        case 2: run.template operator()<2>(); break;
        case 1: run.template operator()<1>(); break;
        default: break;
    }
}
#endif
}
bool interleaved_q4k_available() {
#ifdef STELLAN_HAS_VNNI
    static const bool enabled = available() && vnni() != Vnni::none && !environment_set("STELLAN_RUNTIME_NO_INTERLEAVE");
    return enabled;
#else
    return false;
#endif
}
void interleave_q4k(std::span<const std::byte> rows, std::size_t stride, std::span<std::byte> out) {
    const auto blocks = stride / 144;
    if (rows.size() < 8 * stride || out.size() < blocks * sizeof(Q4kBlock8)) { throw std::runtime_error("Invalid Q4_K interleave"); }
    for (std::size_t b = 0; b < blocks; ++b) {
        Q4kBlock8 block {};
        for (std::size_t r = 0; r < 8; ++r) {
            const auto *p = rows.data() + r * stride + b * 144;
            block.d[r] = stellan::half(read_half(p));
            block.dmin[r] = stellan::half(read_half(p + 2));
            std::uint32_t words[4];
            unpack_q4k(p + 4, words);
            for (std::size_t g = 0; g < 8; ++g) {
                block.scale[g][r] = static_cast<std::uint8_t>((words[g / 4] >> (8 * (g % 4))) & 0xffU);
                block.minimum[g][r] = static_cast<std::uint8_t>((words[2 + g / 4] >> (8 * (g % 4))) & 0xffU);
            }
            const auto *qs = reinterpret_cast<const std::uint8_t *>(p + 16);
            const auto value = [&](std::size_t i) { const auto g = i / 32, k = i % 32; const auto byte = qs[(g / 2) * 32 + k]; return static_cast<unsigned>(g % 2 ? byte >> 4 : byte & 15); };
            for (std::size_t g = 0; g < 8; ++g) {
                for (std::size_t s = 0; s < 4; ++s) {
                    for (std::size_t j = 0; j < 4; ++j) {
                        block.q[g][s][r * 4 + j] = static_cast<std::uint8_t>(value(g * 32 + 4 * s + j) | (value(g * 32 + 16 + 4 * s + j) << 4));
                    }
                }
            }
        }
        std::memcpy(out.data() + b * sizeof(Q4kBlock8), &block, sizeof block);
    }
}
bool interleaved_q4k_batch(std::span<const std::byte> packed, std::span<const std::span<const QuantizedInput>> input, float *output, std::size_t stride) {
#ifdef STELLAN_HAS_VNNI
    if (!interleaved_q4k_available() || input.empty() || input.size() > prefill_batch_limit) { return false; }
    const auto *w = reinterpret_cast<const Q4kBlock8 *>(packed.data());
    const auto blocks = packed.size() / sizeof(Q4kBlock8);
    if (vnni() == Vnni::avx) { interleaved_batch<false>(w, blocks, input, output, stride); }
    else { interleaved_batch<true>(w, blocks, input, output, stride); }
    return true;
#else
    (void)packed; (void)input; (void)output; (void)stride;
    return false;
#endif
}
bool accelerated_attention(std::size_t tokens, std::size_t dim, std::size_t stride, const float *q, const float *keys, const float *values, float scale, float *scores, float *out) {
    static const bool enabled = available();
    if (!enabled || dim % 8 != 0 || dim > 128 || tokens == 0) { return false; }
    attention_row(tokens, dim, stride, q, keys, values, scale, scores, out);
    return true;
}
bool accelerated_ssm_tokens(std::size_t states, std::size_t tokens, const float *input, const float *dt, const float *attenuation,
        const float *const *b, const float *const *c, float skip, float *state, float *output) {
    static const bool enabled = available();
    if (!enabled || states % 64 != 0 || tokens == 0 || tokens > prefill_batch_limit) { return false; }
    recurrent_tokens(states, tokens, input, dt, attenuation, b, c, skip, state, output);
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
namespace stellan {
bool accelerated_attention(std::size_t, std::size_t, std::size_t, const float *, const float *, const float *, float, float *, float *) { return false; }
bool accelerated_ssm_tokens(std::size_t, std::size_t, const float *, const float *, const float *, const float *const *, const float *const *, float, float *, float *) { return false; }
bool accelerated_fine_batch_dot(std::span<const std::byte>, std::span<const std::span<const FineInput>>, std::span<float>) { return false; }
}
#include <arm_neon.h>
namespace stellan {
bool accelerated_dot(std::uint32_t, std::span<const std::byte>, std::span<const float>, float &) { return false; }
bool accelerated_ssm(std::size_t width, std::size_t states, std::span<const float> input, float dt, float decay, float skip,
        std::span<const float> b, std::span<const float> c, std::span<float> state, std::span<float> output) {
    static const bool scalar = environment_set("STELLAN_RUNTIME_SCALAR");
    if (states % 4 != 0 || scalar) { return false; }
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
    static const bool scalar = environment_set("STELLAN_RUNTIME_SCALAR");
    if (scalar) { return false; }
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
bool accelerated_attention(std::size_t, std::size_t, std::size_t, const float *, const float *, const float *, float, float *, float *) { return false; }
bool accelerated_ssm_tokens(std::size_t, std::size_t, const float *, const float *, const float *, const float *const *, const float *const *, float, float *, float *) { return false; }
bool accelerated_fine_batch_dot(std::span<const std::byte>, std::span<const std::span<const FineInput>>, std::span<float>) { return false; }
bool accelerated_dot(std::uint32_t, std::span<const std::byte>, std::span<const float>, float &) { return false; }
bool accelerated_quantized_dot(std::uint32_t, std::span<const std::byte>, std::span<const QuantizedInput>, float &) { return false; }
bool accelerated_ssm(std::size_t, std::size_t, std::span<const float>, float, float, float, std::span<const float>, std::span<const float>, std::span<float>, std::span<float>) { return false; }
}
#endif

#if defined(__aarch64__) || defined(__arm64__)
namespace stellan {
namespace {
template<std::size_t Count>
void arm_batch_tile(std::uint32_t type, std::span<const std::byte> row,
                    std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    std::fill(output.begin(), output.end(), 0.0f);
    const auto half = [](const std::byte *p) {
        const auto bits = static_cast<std::uint16_t>(std::to_integer<unsigned>(p[0]) | (std::to_integer<unsigned>(p[1]) << 8));
        return vgetq_lane_f32(vcvt_f32_f16(vreinterpret_f16_u16(vdup_n_u16(bits))), 0);
    };
    for (std::size_t block = 0; block < input.front().size(); ++block) {
        const auto *p = row.data() + block * (type == 12 ? 144 : 210);
        int sums[Count] {}, minima[Count] {};
        for (std::size_t g = 0; g < 8; ++g) {
            if (type == 12) {
                const auto *scales = p + 4;
                const auto scale = g < 4 ? std::to_integer<unsigned>(scales[g]) & 63U : (std::to_integer<unsigned>(scales[g + 4]) & 15U) | ((std::to_integer<unsigned>(scales[g - 4]) >> 6) << 4);
                const auto offset = g < 4 ? std::to_integer<unsigned>(scales[g + 4]) & 63U : (std::to_integer<unsigned>(scales[g + 4]) >> 4) | ((std::to_integer<unsigned>(scales[g]) >> 6) << 4);
                int32x4_t dots[Count];
                for (auto &dot : dots) dot = vdupq_n_s32(0);
                for (std::size_t j = 0; j < 32; j += 8) {
                    auto q = vld1_u8(reinterpret_cast<const std::uint8_t *>(p + 16 + (g / 2) * 32 + j));
                    if (g % 2 != 0) q = vshr_n_u8(q, 4);
                    q = vand_u8(q, vdup_n_u8(15));
                    for (std::size_t t = 0; t < Count; ++t) dots[t] = vpadalq_s16(dots[t], vmull_s8(vreinterpret_s8_u8(q), vld1_s8(input[t][block].values.data() + g * 32 + j)));
                }
                for (std::size_t t = 0; t < Count; ++t) {
                    sums[t] += static_cast<int>(scale) * vaddvq_s32(dots[t]);
                    minima[t] += static_cast<int>(offset) * (input[t][block].sums[g * 2] + input[t][block].sums[g * 2 + 1]);
                }
            } else {
                const auto quarter = g % 4;
                for (std::size_t j = 0; j < 32; j += 16) {
                    int32x4_t dots[Count];
                    for (auto &dot : dots) dot = vdupq_n_s32(0);
                    for (std::size_t k = 0; k < 16; k += 8) {
                        auto low = vld1_u8(reinterpret_cast<const std::uint8_t *>(p + (g / 4) * 64 + (quarter % 2) * 32 + j + k));
                        if (quarter >= 2) low = vshr_n_u8(low, 4);
                        auto high = vld1_u8(reinterpret_cast<const std::uint8_t *>(p + 128 + (g / 4) * 32 + j + k));
                        high = vshl_u8(high, vdup_n_s8(static_cast<std::int8_t>(-static_cast<int>(quarter * 2))));
                        const auto q = vsub_u8(vorr_u8(vand_u8(low, vdup_n_u8(15)), vshl_n_u8(vand_u8(high, vdup_n_u8(3)), 4)), vdup_n_u8(32));
                        for (std::size_t t = 0; t < Count; ++t) dots[t] = vpadalq_s16(dots[t], vmull_s8(vreinterpret_s8_u8(q), vld1_s8(input[t][block].values.data() + g * 32 + j + k)));
                    }
                    const auto raw = std::to_integer<int>(p[192 + g * 2 + j / 16]);
                    for (std::size_t t = 0; t < Count; ++t) sums[t] += (raw < 128 ? raw : raw - 256) * vaddvq_s32(dots[t]);
                }
            }
        }
        const auto scale = half(type == 12 ? p : p + 208);
        const auto minimum = type == 12 ? half(p + 2) : 0.0f;
        for (std::size_t t = 0; t < Count; ++t) output[t] += input[t][block].scale * (scale * static_cast<float>(sums[t]) - minimum * static_cast<float>(minima[t]));
    }
}
}
bool accelerated_quantized_batch_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const std::span<const QuantizedInput>> input, std::span<float> output) {
    static const bool scalar = environment_set("STELLAN_RUNTIME_SCALAR");
    static const bool untiled = environment_set("STELLAN_RUNTIME_ARM_UNTILED");
    if (scalar || type == 8) return false;
#if defined(__APPLE__)
    // Apple Silicon CI regressed on large Q4 batches; retain the measured reference there.
    const bool retain_large_q4 = type == 12 && input.size() > 8;
#else
    constexpr bool retain_large_q4 = false;
#endif
    if (untiled || input.size() == 1 || retain_large_q4) {
        for (std::size_t t = 0; t < input.size(); ++t) if (!accelerated_quantized_dot(type, row, input[t], output[t])) return false;
        return true;
    }
    std::size_t first = 0;
    for (; first + 8 <= input.size(); first += 8) arm_batch_tile<8>(type, row, input.subspan(first, 8), output.subspan(first, 8));
    if (first + 4 <= input.size()) { arm_batch_tile<4>(type, row, input.subspan(first, 4), output.subspan(first, 4)); first += 4; }
    switch (input.size() - first) {
        case 3: arm_batch_tile<3>(type, row, input.subspan(first), output.subspan(first)); break;
        case 2: arm_batch_tile<2>(type, row, input.subspan(first), output.subspan(first)); break;
        case 1: if (!accelerated_quantized_dot(type, row, input[first], output[first])) return false; break;
        default: break;
    }
    return true;
}
bool interleaved_q4k_available() { return false; }
void interleave_q4k(std::span<const std::byte>, std::size_t, std::span<std::byte>) { throw std::runtime_error("Q4_K interleaving needs x86 VNNI"); }
bool interleaved_q4k_batch(std::span<const std::byte>, std::span<const std::span<const QuantizedInput>>, float *, std::size_t) { return false; }
}
#elif !defined(__x86_64__) && !defined(__i386__) && !defined(_M_X64)
namespace stellan {
bool accelerated_quantized_batch_dot(std::uint32_t, std::span<const std::byte>, std::span<const std::span<const QuantizedInput>>, std::span<float>) { return false; }
bool interleaved_q4k_available() { return false; }
void interleave_q4k(std::span<const std::byte>, std::size_t, std::span<std::byte>) { throw std::runtime_error("Q4_K interleaving needs x86 VNNI"); }
bool interleaved_q4k_batch(std::span<const std::byte>, std::span<const std::span<const QuantizedInput>>, float *, std::size_t) { return false; }
}
#endif
