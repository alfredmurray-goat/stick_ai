#include "runtime.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstring>
#include <limits>
#include <set>
#include <stdexcept>
#include <utility>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace stellan {
namespace {

std::uint64_t add(std::uint64_t a, std::uint64_t b) {
    if (b > std::numeric_limits<std::uint64_t>::max() - a) {
        throw std::runtime_error("Integer overflow in model layout");
    }
    return a + b;
}

std::uint64_t multiply(std::uint64_t a, std::uint64_t b) {
    if (a != 0 && b > std::numeric_limits<std::uint64_t>::max() / a) {
        throw std::runtime_error("Integer overflow in tensor dimensions");
    }
    return a * b;
}

std::uint16_t u16(const std::byte *p) {
    return static_cast<std::uint16_t>(std::to_integer<unsigned>(p[0]) |
                                     (std::to_integer<unsigned>(p[1]) << 8));
}

void validate_utf8(std::span<const std::byte> bytes) {
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        const auto first = std::to_integer<unsigned>(bytes[i]);
        if (first < 128) { continue; }
        const auto count = first >= 0xc2 && first <= 0xdf ? 1U :
            first >= 0xe0 && first <= 0xef ? 2U : first >= 0xf0 && first <= 0xf4 ? 3U : 0U;
        if (count == 0 || bytes.size() - i - 1 < count) { throw std::runtime_error("Invalid UTF-8 in GGUF name"); }
        auto code = first & ((1U << (6 - count)) - 1);
        for (unsigned j = 0; j < count; ++j) {
            const auto next = std::to_integer<unsigned>(bytes[++i]);
            if ((next & 0xc0) != 0x80) { throw std::runtime_error("Invalid UTF-8 in GGUF name"); }
            code = (code << 6) | (next & 63);
        }
        const auto minimum = count == 1 ? 128U : count == 2 ? 2048U : 65536U;
        if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
            throw std::runtime_error("Invalid UTF-8 in GGUF name");
        }
    }
}

class Reader {
public:
    explicit Reader(std::span<const std::byte> bytes) : bytes_(bytes) {}
    std::uint64_t integer(std::size_t size) {
        const auto b = take(size);
        std::uint64_t result = 0;
        for (std::size_t i = 0; i < size; ++i) {
            result |= static_cast<std::uint64_t>(std::to_integer<unsigned>(b[i])) << (i * 8);
        }
        return result;
    }
    std::span<const std::byte> take(std::uint64_t size) {
        if (size > bytes_.size() - position_) {
            throw std::runtime_error("Truncated GGUF file");
        }
        const auto result = bytes_.subspan(position_, static_cast<std::size_t>(size));
        position_ += static_cast<std::size_t>(size);
        return result;
    }
    std::string string(std::size_t limit = 1048576) {
        const auto length = integer(8);
        if (length > limit) {
            throw std::runtime_error("GGUF string exceeds safety limit");
        }
        const auto value = take(length);
        retained_strings_ = add(retained_strings_, length);
        if (retained_strings_ > 33554432) { throw std::runtime_error("GGUF names exceed memory safety budget"); }
        validate_utf8(value);
        return std::string(reinterpret_cast<const char *>(value.data()), value.size());
    }
    void skip_value(std::uint32_t type, unsigned depth = 0) {
        static constexpr std::array<std::size_t, 13> sizes = {1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8};
        if (type >= sizes.size()) {
            throw std::runtime_error("Unknown GGUF metadata type");
        }
        if (type == 8) {
            take(integer(8));
        } else if (type == 9) {
            if (depth != 0) {
                throw std::runtime_error("Nested metadata arrays are unsupported");
            }
            const auto element = static_cast<std::uint32_t>(integer(4));
            const auto count = integer(8);
            if (element >= sizes.size() || element == 9 || count > 10000000) {
                throw std::runtime_error("Invalid GGUF metadata array");
            }
            if (element == 8) {
                for (std::uint64_t i = 0; i < count; ++i) {
                    skip_value(element, depth + 1);
                }
            } else {
                take(multiply(count, sizes[element]));
            }
        } else {
            take(sizes[type]);
        }
    }
    std::size_t position() const { return position_; }
private:
    std::span<const std::byte> bytes_;
    std::size_t position_ = 0;
    std::uint64_t retained_strings_ = 0;
};

std::pair<std::size_t, std::size_t> layout(std::uint32_t type) {
    switch (type) {
        case 0: return {1, 4};
        case 1: return {1, 2};
        case 2: return {32, 18};
        case 3: return {32, 20};
        case 6: return {32, 22};
        case 7: return {32, 24};
        case 8: return {32, 34};
        case 10: return {256, 84};
        case 11: return {256, 110};
        case 12: return {256, 144};
        case 13: return {256, 176};
        case 14: return {256, 210};
        case 30: return {1, 2};
        default: throw std::runtime_error("Unsupported tensor storage type " + std::to_string(type));
    }
}

}

Mapping::Mapping(const std::filesystem::path &path) {
    if (sizeof(std::size_t) < 8 || std::endian::native != std::endian::little) {
        throw std::runtime_error("This prototype needs a little-endian 64-bit computer");
    }
#ifdef _WIN32
    const auto file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("Cannot open model");
    }
    LARGE_INTEGER size;
    if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0) {
        CloseHandle(file);
        throw std::runtime_error("Cannot read model size");
    }
    const auto mapping = CreateFileMappingW(file, nullptr, PAGE_READONLY, 0, 0, nullptr);
    if (mapping == nullptr) {
        CloseHandle(file);
        throw std::runtime_error("Cannot map model");
    }
    const auto data = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
    if (data == nullptr) {
        CloseHandle(mapping);
        CloseHandle(file);
        throw std::runtime_error("Cannot map model data");
    }
    file_ = file;
    mapping_ = mapping;
    size_ = static_cast<std::size_t>(size.QuadPart);
    data_ = static_cast<const std::byte *>(data);
#else
    const auto fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        throw std::runtime_error("Cannot open model");
    }
    struct stat info {};
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0) {
        close(fd);
        throw std::runtime_error("Model is empty or is not a regular file");
    }
    const auto length = static_cast<std::size_t>(info.st_size);
    const auto data = mmap(nullptr, length, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (data == MAP_FAILED) {
        throw std::runtime_error("Cannot map model");
    }
    size_ = length;
    data_ = static_cast<const std::byte *>(data);
#endif
}

Mapping::~Mapping() {
#ifdef _WIN32
    if (data_ != nullptr) { UnmapViewOfFile(data_); }
    if (mapping_ != nullptr) { CloseHandle(mapping_); }
    if (file_ != nullptr) { CloseHandle(file_); }
#else
    if (data_ != nullptr) { munmap(const_cast<std::byte *>(data_), size_); }
#endif
}

std::span<const std::byte> Mapping::bytes() const { return {data_, size_}; }

Model::Model(std::span<const std::byte> bytes) : bytes_(bytes) {
    Reader reader(bytes);
    if (reader.integer(4) != 0x46554747) {
        throw std::runtime_error("Not a little-endian GGUF file");
    }
    const auto version = reader.integer(4);
    if (version != 2 && version != 3) {
        throw std::runtime_error("Unsupported GGUF version");
    }
    const auto count = reader.integer(8);
    const auto metadata = reader.integer(8);
    if (count > 100000 || metadata > 100000) {
        throw std::runtime_error("GGUF header exceeds safety limits");
    }
    std::uint64_t alignment = 32;
    std::set<std::string> keys;
    for (std::uint64_t i = 0; i < metadata; ++i) {
        const auto key = reader.string(65536);
        if (!keys.insert(key).second) {
            throw std::runtime_error("Duplicate metadata key");
        }
        const auto type = static_cast<std::uint32_t>(reader.integer(4));
        if (key == "general.architecture") {
            if (type != 8) { throw std::runtime_error("Invalid architecture metadata"); }
            architecture_ = reader.string(1024);
        } else if (key == "general.alignment") {
            if (type != 4) { throw std::runtime_error("Invalid alignment metadata"); }
            alignment = reader.integer(4);
        } else {
            reader.skip_value(type);
        }
    }
    if (architecture_.empty() || alignment == 0 || alignment > 1048576 || (alignment & (alignment - 1)) != 0) {
        throw std::runtime_error("Missing architecture or invalid alignment");
    }
    std::set<std::string> names;
    for (std::uint64_t i = 0; i < count; ++i) {
        Tensor tensor;
        tensor.name = reader.string(65536);
        if (tensor.name.empty() || !names.insert(tensor.name).second) {
            throw std::runtime_error("Empty or duplicate tensor name");
        }
        const auto rank = reader.integer(4);
        if (rank == 0 || rank > 4) { throw std::runtime_error("Invalid tensor rank"); }
        std::uint64_t elements = 1;
        for (std::uint64_t j = 0; j < rank; ++j) {
            const auto dimension = reader.integer(8);
            if (dimension == 0) { throw std::runtime_error("Empty tensor dimension"); }
            elements = multiply(elements, dimension);
            tensor.dimensions.push_back(dimension);
        }
        tensor.type = static_cast<std::uint32_t>(reader.integer(4));
        tensor.offset = reader.integer(8);
        const auto [block, storage] = layout(tensor.type);
        if (tensor.offset % alignment != 0 || tensor.dimensions[0] % block != 0) {
            throw std::runtime_error("Misaligned tensor or invalid quantization shape");
        }
        tensor.size = multiply(elements / block, storage);
        tensors_.push_back(std::move(tensor));
    }
    payload_offset_ = add(reader.position(), alignment - 1) & ~(alignment - 1);
    if (payload_offset_ > bytes.size()) { throw std::runtime_error("Missing tensor payload"); }
    std::vector<std::pair<std::uint64_t, std::uint64_t>> ranges;
    for (const auto &tensor : tensors_) {
        const auto start = add(payload_offset_, tensor.offset);
        const auto end = add(start, tensor.size);
        if (end > bytes.size()) { throw std::runtime_error("Tensor extends past end of file"); }
        ranges.emplace_back(start, end);
    }
    std::sort(ranges.begin(), ranges.end());
    for (std::size_t i = 1; i < ranges.size(); ++i) {
        if (ranges[i].first < ranges[i - 1].second) { throw std::runtime_error("Overlapping tensors"); }
    }
}

const std::string &Model::architecture() const { return architecture_; }
const std::vector<Tensor> &Model::tensors() const { return tensors_; }
std::uint64_t Model::payload_offset() const { return payload_offset_; }
std::span<const std::byte> Model::data(const Tensor &tensor) const {
    const auto start = add(payload_offset_, tensor.offset);
    if (start > bytes_.size() || tensor.size > bytes_.size() - start) {
        throw std::runtime_error("Invalid tensor data range");
    }
    return bytes_.subspan(static_cast<std::size_t>(start), static_cast<std::size_t>(tensor.size));
}

float half(std::uint16_t bits) {
    const auto sign = (static_cast<std::uint32_t>(bits) & 0x8000U) << 16;
    const auto exponent = (bits >> 10) & 31U;
    const auto fraction = bits & 1023U;
    if (exponent == 0) {
        return std::copysign(std::ldexp(static_cast<float>(fraction), -24), sign ? -1.0F : 1.0F);
    }
    if (exponent == 31) { return std::bit_cast<float>(sign | 0x7f800000U | (fraction << 13)); }
    return std::bit_cast<float>(sign | ((exponent + 112U) << 23) | (fraction << 13));
}

std::size_t row_bytes(std::uint32_t type, std::size_t columns) {
    const auto [block, size] = layout(type);
    if (columns == 0 || columns % block != 0) { throw std::runtime_error("Invalid row width"); }
    return static_cast<std::size_t>(multiply(columns / block, size));
}

float dot(std::uint32_t type, std::span<const std::byte> row, std::span<const float> input) {
    if (row.size() != row_bytes(type, input.size())) { throw std::runtime_error("Incorrect row size"); }
    float sum = 0;
    if (type == 0 || type == 1) {
        for (std::size_t i = 0; i < input.size(); ++i) {
            float weight;
            if (type == 0) {
                std::memcpy(&weight, row.data() + i * 4, 4);
            } else {
                weight = half(u16(row.data() + i * 2));
            }
            sum += weight * input[i];
        }
    } else if (type == 8) {
        for (std::size_t b = 0; b < input.size() / 32; ++b) {
            const auto *p = row.data() + b * 34;
            float partial = 0;
            for (std::size_t j = 0; j < 32; ++j) {
                const auto q = std::to_integer<int>(p[2 + j]);
                partial += static_cast<float>(q < 128 ? q : q - 256) * input[b * 32 + j];
            }
            sum += half(u16(p)) * partial;
        }
    } else if (type == 12) {
        for (std::size_t b = 0; b < input.size() / 256; ++b) {
            const auto *p = row.data() + b * 144;
            const auto d = half(u16(p));
            const auto minimum = half(u16(p + 2));
            for (std::size_t g = 0; g < 8; ++g) {
                const auto scale = g < 4 ? std::to_integer<unsigned>(p[4 + g]) & 63U :
                    (std::to_integer<unsigned>(p[8 + g]) & 15U) | ((std::to_integer<unsigned>(p[g]) >> 6) << 4);
                const auto offset = g < 4 ? std::to_integer<unsigned>(p[8 + g]) & 63U :
                    (std::to_integer<unsigned>(p[8 + g]) >> 4) | ((std::to_integer<unsigned>(p[4 + g]) >> 6) << 4);
                float products = 0;
                float inputs = 0;
                for (std::size_t j = 0; j < 32; ++j) {
                    const auto packed = std::to_integer<unsigned>(p[16 + (g / 2) * 32 + j]);
                    const auto q = (packed >> ((g % 2) * 4)) & 15U;
                    const auto x = input[b * 256 + g * 32 + j];
                    products += static_cast<float>(q) * x;
                    inputs += x;
                }
                sum += d * static_cast<float>(scale) * products - minimum * static_cast<float>(offset) * inputs;
            }
        }
    } else {
        throw std::runtime_error("No compute kernel for tensor storage type " + std::to_string(type));
    }
    return sum;
}

void matvec(std::uint32_t type, std::span<const std::byte> weights, std::size_t rows,
            std::span<const float> input, std::span<float> output) {
    const auto stride = row_bytes(type, input.size());
    if (output.size() != rows || weights.size() != multiply(rows, stride)) {
        throw std::runtime_error("Matrix dimensions do not match buffers");
    }
    for (std::size_t row = 0; row < rows; ++row) {
        output[row] = dot(type, weights.subspan(row * stride, stride), input);
    }
}

void mamba2_step(std::size_t heads, std::size_t width, std::size_t states, std::size_t groups,
                 std::span<const float> input, std::span<const float> dt,
                 std::span<const float> decay, std::span<const float> b,
                 std::span<const float> c, std::span<const float> skip,
                 std::span<float> state, std::span<float> output) {
    const auto channels = multiply(heads, width);
    const auto coefficients = multiply(groups, states);
    if (heads == 0 || width == 0 || states == 0 || groups == 0 || heads % groups != 0 ||
        input.size() != channels || output.size() != channels || dt.size() != heads ||
        decay.size() != heads || skip.size() != heads || b.size() != coefficients ||
        c.size() != coefficients || state.size() != multiply(channels, states)) {
        throw std::runtime_error("Invalid Mamba2 recurrent state dimensions");
    }
    for (std::size_t h = 0; h < heads; ++h) {
        if (!std::isfinite(dt[h]) || dt[h] < 0 || !std::isfinite(decay[h]) || decay[h] > 0) {
            throw std::runtime_error("Mamba2 requires a finite nonnegative time step and nonpositive decay");
        }
    }
    for (std::size_t h = 0; h < heads; ++h) {
        const auto attenuation = std::exp(dt[h] * decay[h]);
        const auto group = h / (heads / groups);
        for (std::size_t p = 0; p < width; ++p) {
            const auto channel = h * width + p;
            float y = skip[h] * input[channel];
            for (std::size_t n = 0; n < states; ++n) {
                const auto coefficient = group * states + n;
                auto &value = state[channel * states + n];
                value = attenuation * value + dt[h] * b[coefficient] * input[channel];
                y += c[coefficient] * value;
            }
            output[channel] = y;
        }
    }
}

std::string json_string(const std::string &value) {
    static constexpr char hex[] = "0123456789abcdef";
    std::string result = "\"";
    for (const unsigned char c : value) {
        if (c == '\"' || c == '\\') {
            result += '\\';
            result += static_cast<char>(c);
        } else if (c < 32 || c == 127) {
            result += "\\u00";
            result += hex[c >> 4];
            result += hex[c & 15];
        } else {
            result += static_cast<char>(c);
        }
    }
    result += '\"';
    return result;
}

}
