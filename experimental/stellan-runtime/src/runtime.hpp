#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <filesystem>
#include <map>
#include <memory>
#include <span>
#include <set>
#include <string>
#include <vector>

namespace stellan {

class Mapping {
public:
    explicit Mapping(const std::filesystem::path &path);
    ~Mapping();
    Mapping(const Mapping &) = delete;
    Mapping &operator=(const Mapping &) = delete;
    std::span<const std::byte> bytes() const;
private:
    const std::byte *data_ = nullptr;
    std::size_t size_ = 0;
#ifdef _WIN32
    void *file_ = nullptr;
    void *mapping_ = nullptr;
#endif
};

struct Tensor {
    std::string name;
    std::vector<std::uint64_t> dimensions;
    std::uint32_t type;
    std::uint64_t offset;
    std::uint64_t size;
};

class Model {
public:
    explicit Model(std::span<const std::byte> bytes);
    const std::string &architecture() const;
    const std::vector<Tensor> &tensors() const;
    std::span<const std::byte> data(const Tensor &tensor) const;
    std::uint64_t payload_offset() const;
    double number(const std::string &key) const;
    const std::vector<std::string> &vocabulary() const;
    const std::vector<float> &scores() const;
    const std::vector<std::int32_t> &token_types() const;
    const std::vector<std::string> &merges() const;
    const std::string &text(const std::string &key) const;
    bool has(const std::string &key) const;
private:
    std::span<const std::byte> bytes_;
    std::string architecture_;
    std::vector<Tensor> tensors_;
    std::uint64_t payload_offset_ = 0;
    std::map<std::string, double> numbers_;
    std::vector<std::string> vocabulary_;
    std::vector<float> scores_;
    std::vector<std::int32_t> token_types_;
    std::vector<std::string> merges_;
    std::map<std::string, std::string> texts_;
    std::set<std::string> metadata_keys_;
};

float half(std::uint16_t bits);
std::uint16_t to_half(float value);
std::size_t row_bytes(std::uint32_t type, std::size_t columns);
float dot(std::uint32_t type, std::span<const std::byte> row, std::span<const float> input);
void decode_row(std::uint32_t type, std::span<const std::byte> row, std::span<float> output);
void matvec(std::uint32_t type, std::span<const std::byte> weights, std::size_t rows,
            std::span<const float> input, std::span<float> output);
void mamba2_step(std::size_t heads, std::size_t width, std::size_t states, std::size_t groups,
                 std::span<const float> input, std::span<const float> dt,
                 std::span<const float> decay, std::span<const float> b,
                 std::span<const float> c, std::span<const float> skip,
                 std::span<float> state, std::span<float> output);
std::string json_string(const std::string &value);
std::string sha256(std::span<const std::byte> bytes);
std::uint64_t ram_bytes();
struct Usage { std::uint64_t peak_rss_bytes; double cpu_ms; };
Usage usage();
struct alignas(32) QuantizedInput {
    std::array<std::int8_t, 256> values;
    std::array<std::int16_t, 16> sums;
    float scale;
};
std::vector<QuantizedInput> quantize_input(std::span<const float> input);
float quantized_dot(std::uint32_t type, std::span<const std::byte> row, std::span<const QuantizedInput> input);

}
