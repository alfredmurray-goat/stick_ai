#include "inflate.hpp"

#include <array>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>

// DEFLATE (RFC 1951) and gzip (RFC 1952) decoding for update bundles, streamed: the output goes to a callback in
// pieces and only the 32 KiB window is kept, so a large update never sits in memory. Every malformed input throws.
namespace stellan::inflate {
namespace {
constexpr std::array<std::uint16_t, 29> length_base {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
constexpr std::array<std::uint8_t, 29> length_extra {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
constexpr std::array<std::uint16_t, 30> distance_base {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577};
constexpr std::array<std::uint8_t, 30> distance_extra {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};
constexpr std::array<std::uint8_t, 19> code_order {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};

[[noreturn]] void fail() { throw std::runtime_error("Invalid compressed update data"); }

struct Huffman {
    std::array<std::uint16_t, 16> counts {};
    std::vector<std::uint16_t> symbols;
    void build(const std::uint8_t *lengths, std::size_t n) {
        counts.fill(0);
        for (std::size_t i = 0; i < n; ++i) { ++counts[lengths[i]]; }
        counts[0] = 0;
        int left = 1;
        for (int len = 1; len < 16; ++len) { left <<= 1; left -= counts[len]; if (left < 0) { fail(); } } // over-subscribed
        std::array<std::uint16_t, 16> offsets {};
        for (int len = 1; len < 15; ++len) { offsets[len + 1] = static_cast<std::uint16_t>(offsets[len] + counts[len]); }
        symbols.assign(n, 0);
        for (std::size_t i = 0; i < n; ++i) { if (lengths[i]) { symbols[offsets[lengths[i]]++] = static_cast<std::uint16_t>(i); } }
    }
};
}

struct Decoder::State {
    // Input
    std::vector<std::uint8_t> in; std::size_t at = 0; std::uint32_t bits = 0; int count = 0;
    // Window and pending output
    std::vector<std::uint8_t> window = std::vector<std::uint8_t>(32768); std::size_t written = 0;
    std::vector<std::uint8_t> out;
    std::uint32_t crc = 0xFFFFFFFFu; std::uint64_t total = 0;
};

namespace {
std::uint32_t crc_table[256];
const bool crc_ready = [] {
    for (std::uint32_t n = 0; n < 256; ++n) { std::uint32_t c = n; for (int k = 0; k < 8; ++k) { c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1; } crc_table[n] = c; }
    return true;
}();
}

// The decoder runs once the whole member is buffered? No: it pulls bytes through need(), which throws NeedMore when
// the buffered input runs out; feed() then keeps the unread bytes and the caller resumes from the block start. To keep
// that simple and exact, decoding restarts each DEFLATE block from a saved position (blocks are at most a few hundred
// KiB of input), and output of a block is only released once the block has fully decoded.
namespace {
struct NeedMore {};
struct Reader {
    Decoder::State &s;
    std::uint32_t need(int n) {
        while (s.count < n) {
            if (s.at >= s.in.size()) { throw NeedMore {}; }
            s.bits |= static_cast<std::uint32_t>(s.in[s.at++]) << s.count; s.count += 8;
        }
        const auto value = s.bits & ((1u << n) - 1);
        s.bits >>= n; s.count -= n;
        return value;
    }
    int decode(const Huffman &h) {
        int code = 0, first = 0, index = 0;
        for (int len = 1; len < 16; ++len) {
            code |= static_cast<int>(need(1));
            const int count = h.counts[len];
            if (code - count < first) { return h.symbols[static_cast<std::size_t>(index + (code - first))]; }
            index += count; first += count; first <<= 1; code <<= 1;
        }
        fail();
    }
};
}

Decoder::Decoder() : state_(std::make_unique<State>()) {}
Decoder::Decoder(bool raw) : stage_(raw ? Stage::block : Stage::header), state_(std::make_unique<State>()), raw_(raw) {}
Decoder::~Decoder() = default;

void Decoder::emit(std::uint8_t byte) {
    auto &s = *state_;
    s.window[s.written++ & 32767] = byte;
    s.out.push_back(byte);
}

void Decoder::feed(const std::uint8_t *data, std::size_t size, const std::function<void(const std::uint8_t *, std::size_t)> &sink) {
    auto &s = *state_;
    s.in.insert(s.in.end(), data, data + size);
    for (;;) {
        if (stage_ == Stage::done) { if (s.at < s.in.size()) { fail(); } return; } // nothing may follow the gzip member
        // Save the position so an incomplete block can be retried when more input arrives.
        const auto saved_at = s.at; const auto saved_bits = s.bits; const auto saved_count = s.count; const auto saved_written = s.written;
        std::vector<std::uint8_t> saved_window;
        try {
            Reader r {s};
            if (stage_ == Stage::header) {
                // gzip header: magic, deflate, flags; optional extra, name, comment, header CRC.
                if (r.need(8) != 0x1f || r.need(8) != 0x8b || r.need(8) != 8) { fail(); }
                const auto flags = r.need(8);
                if (flags & 0xE0) { fail(); }
                for (int i = 0; i < 6; ++i) { r.need(8); }
                if (flags & 4) { const auto length = r.need(16); for (std::uint32_t i = 0; i < length; ++i) { r.need(8); } }
                if (flags & 8) { while (r.need(8) != 0) {} }
                if (flags & 16) { while (r.need(8) != 0) {} }
                if (flags & 2) { r.need(16); }
                stage_ = Stage::block;
                continue;
            }
            if (stage_ == Stage::trailer) {
                if (s.count % 8) { r.need(s.count % 8); }
                const auto crc = r.need(16) | (r.need(16) << 16);
                const auto size = r.need(16) | (r.need(16) << 16);
                if (crc != (s.crc ^ 0xFFFFFFFFu) || size != static_cast<std::uint32_t>(s.total)) { throw std::runtime_error("Update data checksum failed"); }
                stage_ = Stage::done;
                continue;
            }
            saved_window = s.window;
            const auto last = r.need(1);
            const auto type = r.need(2);
            if (type == 0) {
                r.need(s.count % 8);
                const auto length = r.need(16), inverse = r.need(16);
                if ((length ^ 0xFFFF) != inverse) { fail(); }
                for (std::uint32_t i = 0; i < length; ++i) { emit(static_cast<std::uint8_t>(r.need(8))); }
            } else if (type == 1 || type == 2) {
                Huffman literals, distances;
                std::array<std::uint8_t, 320> lengths {};
                std::size_t nlen = 288, ndist = 30;
                if (type == 1) {
                    for (int i = 0; i < 144; ++i) { lengths[i] = 8; }
                    for (int i = 144; i < 256; ++i) { lengths[i] = 9; }
                    for (int i = 256; i < 280; ++i) { lengths[i] = 7; }
                    for (int i = 280; i < 288; ++i) { lengths[i] = 8; }
                    for (int i = 0; i < 30; ++i) { lengths[288 + i] = 5; }
                } else {
                    nlen = r.need(5) + 257; ndist = r.need(5) + 1;
                    const auto ncode = r.need(4) + 4;
                    if (nlen > 286 || ndist > 30) { fail(); }
                    std::array<std::uint8_t, 19> code_lengths {};
                    for (std::uint32_t i = 0; i < ncode; ++i) { code_lengths[code_order[i]] = static_cast<std::uint8_t>(r.need(3)); }
                    Huffman codes; codes.build(code_lengths.data(), 19);
                    std::size_t index = 0;
                    std::array<std::uint8_t, 320> all {};
                    while (index < nlen + ndist) {
                        int symbol = r.decode(codes);
                        if (symbol < 16) { all[index++] = static_cast<std::uint8_t>(symbol); continue; }
                        std::uint8_t value = 0; std::uint32_t repeat = 0;
                        if (symbol == 16) { if (index == 0) { fail(); } value = all[index - 1]; repeat = 3 + r.need(2); }
                        else if (symbol == 17) { repeat = 3 + r.need(3); }
                        else { repeat = 11 + r.need(7); }
                        if (index + repeat > nlen + ndist) { fail(); }
                        while (repeat--) { all[index++] = value; }
                    }
                    if (all[256] == 0) { fail(); } // no end-of-block code
                    for (std::size_t i = 0; i < nlen; ++i) { lengths[i] = all[i]; }
                    for (std::size_t i = 0; i < ndist; ++i) { lengths[288 + i] = all[nlen + i]; }
                }
                literals.build(lengths.data(), nlen);
                distances.build(lengths.data() + 288, ndist);
                for (;;) {
                    const int symbol = r.decode(literals);
                    if (symbol < 256) { emit(static_cast<std::uint8_t>(symbol)); continue; }
                    if (symbol == 256) { break; }
                    const int li = symbol - 257;
                    if (li >= 29) { fail(); }
                    const auto length = length_base[static_cast<std::size_t>(li)] + r.need(length_extra[static_cast<std::size_t>(li)]);
                    const int di = r.decode(distances);
                    if (di >= 30) { fail(); }
                    const auto distance = distance_base[static_cast<std::size_t>(di)] + r.need(distance_extra[static_cast<std::size_t>(di)]);
                    if (distance > s.written) { fail(); }
                    for (std::uint32_t i = 0; i < length; ++i) { emit(s.window[(s.written - distance) & 32767]); }
                }
            } else { fail(); }
            // The block is complete: release its output and drop consumed input.
            for (const auto byte : s.out) { s.crc = crc_table[(s.crc ^ byte) & 0xFF] ^ (s.crc >> 8); }
            s.total += s.out.size();
            if (s.total > limit_) { throw std::runtime_error("The update is larger than expected"); }
            if (!s.out.empty()) { sink(s.out.data(), s.out.size()); }
            s.out.clear();
            s.in.erase(s.in.begin(), s.in.begin() + static_cast<std::ptrdiff_t>(s.at)); s.at = 0;
            if (last) { stage_ = raw_ ? Stage::done : Stage::trailer; }
        } catch (const NeedMore &) {
            s.at = saved_at; s.bits = saved_bits; s.count = saved_count; s.written = saved_written; s.out.clear();
            if (!saved_window.empty()) { s.window = std::move(saved_window); }
            if (s.in.size() > 64 * 1024 * 1024) { fail(); } // a single block this large is not a real update
            return;
        }
    }
}

bool Decoder::finished() const { return stage_ == Stage::done; }

// stellan-host --gunzip-check: gzip bytes on stdin, the decoded bytes on stdout (exit 1 with a message on bad data).
int gunzip_check() {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
    Decoder decoder;
    std::vector<char> buffer(65536);
    try {
        for (;;) {
            std::cin.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
            const auto got = static_cast<std::size_t>(std::cin.gcount());
            if (got == 0) { break; }
            decoder.feed(reinterpret_cast<const std::uint8_t *>(buffer.data()), got, [](const std::uint8_t *data, std::size_t size) { std::cout.write(reinterpret_cast<const char *>(data), static_cast<std::streamsize>(size)); });
        }
        if (!decoder.finished()) { throw std::runtime_error("Truncated update"); }
        std::cout.flush();
        return 0;
    } catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
}
