#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <span>
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
private:
    std::span<const std::byte> bytes_;
    std::string architecture_;
    std::vector<Tensor> tensors_;
    std::uint64_t payload_offset_ = 0;
};

float half(std::uint16_t bits);
std::size_t row_bytes(std::uint32_t type, std::size_t columns);
float dot(std::uint32_t type, std::span<const std::byte> row, std::span<const float> input);
void matvec(std::uint32_t type, std::span<const std::byte> weights, std::size_t rows,
            std::span<const float> input, std::span<float> output);
void mamba2_step(std::size_t heads, std::size_t width, std::size_t states, std::size_t groups,
                 std::span<const float> input, std::span<const float> dt,
                 std::span<const float> decay, std::span<const float> b,
                 std::span<const float> c, std::span<const float> skip,
                 std::span<float> state, std::span<float> output);
std::string json_string(const std::string &value);

}
