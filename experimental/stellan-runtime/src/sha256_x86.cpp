#include "runtime.hpp"

#if defined(__x86_64__) || defined(__i386__) || defined(_M_X64)
#include <immintrin.h>
#ifdef _MSC_VER
#include <intrin.h>
#define STELLAN_SHA
#else
#define STELLAN_SHA __attribute__((target("sha,ssse3,sse4.1")))
#endif

namespace stellan {
namespace {
bool supported() {
    if (environment_set("STELLAN_RUNTIME_SCALAR")) { return false; }
#ifdef _MSC_VER
    int registers[4];
    __cpuid(registers, 0);
    if (registers[0] < 7) { return false; }
    __cpuid(registers, 1);
    if ((registers[2] & (1 << 9)) == 0 || (registers[2] & (1 << 19)) == 0) { return false; }
    __cpuidex(registers, 7, 0);
    return (registers[1] & (1 << 29)) != 0;
#else
    return __builtin_cpu_supports("sha") && __builtin_cpu_supports("ssse3") && __builtin_cpu_supports("sse4.1");
#endif
}
STELLAN_SHA void blocks(std::span<const std::byte> bytes, std::span<std::uint32_t, 8> state, std::span<const std::uint32_t, 64> constants) {
    auto abcd = _mm_loadu_si128(reinterpret_cast<const __m128i *>(state.data()));
    auto efgh = _mm_loadu_si128(reinterpret_cast<const __m128i *>(state.data() + 4));
    const auto shuffled = _mm_shuffle_epi32(abcd, 0xB1);
    efgh = _mm_shuffle_epi32(efgh, 0x1B);
    auto abef = _mm_alignr_epi8(shuffled, efgh, 8);
    auto cdgh = _mm_blend_epi16(efgh, shuffled, 0xF0);
    const auto endian = _mm_setr_epi8(3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12);
    for (std::size_t offset = 0; offset < bytes.size(); offset += 64) {
        const auto saved_abef = abef, saved_cdgh = cdgh;
        __m128i words[4];
        for (std::size_t i = 0; i < 4; ++i) {
            words[i] = _mm_shuffle_epi8(_mm_loadu_si128(reinterpret_cast<const __m128i *>(bytes.data() + offset + i * 16)), endian);
        }
        for (std::size_t group = 0; group < 16; ++group) {
            const auto slot = group % 4;
            if (group >= 4) {
                auto next = _mm_sha256msg1_epu32(words[slot], words[(slot + 1) % 4]);
                next = _mm_add_epi32(next, _mm_alignr_epi8(words[(slot + 3) % 4], words[(slot + 2) % 4], 4));
                words[slot] = _mm_sha256msg2_epu32(next, words[(slot + 3) % 4]);
            }
            auto message = _mm_add_epi32(words[slot], _mm_loadu_si128(reinterpret_cast<const __m128i *>(constants.data() + group * 4)));
            cdgh = _mm_sha256rnds2_epu32(cdgh, abef, message);
            message = _mm_shuffle_epi32(message, 0x0E);
            abef = _mm_sha256rnds2_epu32(abef, cdgh, message);
        }
        abef = _mm_add_epi32(abef, saved_abef);
        cdgh = _mm_add_epi32(cdgh, saved_cdgh);
    }
    const auto shuffled_abef = _mm_shuffle_epi32(abef, 0x1B);
    cdgh = _mm_shuffle_epi32(cdgh, 0xB1);
    abcd = _mm_blend_epi16(shuffled_abef, cdgh, 0xF0);
    efgh = _mm_alignr_epi8(cdgh, shuffled_abef, 8);
    _mm_storeu_si128(reinterpret_cast<__m128i *>(state.data()), abcd);
    _mm_storeu_si128(reinterpret_cast<__m128i *>(state.data() + 4), efgh);
}
}
bool accelerated_sha256(std::span<const std::byte> bytes, std::span<std::uint32_t, 8> state, std::span<const std::uint32_t, 64> constants) {
    static const bool enabled = supported();
    if (!enabled) { return false; }
    if (bytes.size() % 64 != 0) { throw std::runtime_error("SHA blocks must be complete"); }
    blocks(bytes, state, constants);
    return true;
}
}
#else
namespace stellan {
bool accelerated_sha256(std::span<const std::byte>, std::span<std::uint32_t, 8>, std::span<const std::uint32_t, 64>) { return false; }
}
#endif
