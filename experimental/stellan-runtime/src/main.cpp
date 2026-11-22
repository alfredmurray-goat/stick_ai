#include "runtime.hpp"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string_view>

namespace {
volatile std::sig_atomic_t cancelled = 0;
void interrupt(int) { cancelled = 1; }
using Clock = std::chrono::steady_clock;
double milliseconds(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

int run(int argc, char **argv) {
    if (argc < 3 || (std::string_view(argv[1]) != "inspect" && std::string_view(argv[1]) != "tensorbench")) {
        std::cerr << "Usage: stellan-runtime inspect MODEL | tensorbench MODEL TENSOR [REPETITIONS]\n";
        return 2;
    }
    const bool bench = std::string_view(argv[1]) == "tensorbench";
    if ((!bench && argc != 3) || (bench && argc != 4 && argc != 5)) {
        throw std::runtime_error("Incorrect number of arguments");
    }
    const auto start = Clock::now();
    const stellan::Mapping mapping(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(argv[2]))));
    const stellan::Model model(mapping.bytes());
    const auto load_ms = milliseconds(start);
    std::cout << std::setprecision(12);
    if (!bench) {
        std::cout << "{\"runtime\":\"stellan-native-prototype\",\"generation_supported\":false,\"architecture\":"
                  << stellan::json_string(model.architecture()) << ",\"mapped_bytes\":" << mapping.bytes().size()
                  << ",\"load_ms\":" << load_ms << ",\"tensors\":[";
        bool first = true;
        for (const auto &tensor : model.tensors()) {
            if (!first) { std::cout << ','; }
            first = false;
            std::cout << "{\"name\":" << stellan::json_string(tensor.name) << ",\"type\":" << tensor.type
                      << ",\"bytes\":" << tensor.size << ",\"dimensions\":[";
            for (std::size_t i = 0; i < tensor.dimensions.size(); ++i) {
                if (i != 0) { std::cout << ','; }
                std::cout << tensor.dimensions[i];
            }
            std::cout << "]}";
        }
        std::cout << "]}\n";
        return 0;
    }
    unsigned repetitions = 5;
    if (argc == 5) {
        const std::string_view value(argv[4]);
        const auto parsed = std::from_chars(value.data(), value.data() + value.size(), repetitions);
        if (parsed.ec != std::errc() || parsed.ptr != value.data() + value.size() || repetitions == 0 || repetitions > 100) {
            throw std::runtime_error("Repetitions must be between 1 and 100");
        }
    }
    const auto tensor = std::find_if(model.tensors().begin(), model.tensors().end(), [&](const auto &item) {
        return item.name == argv[3];
    });
    if (tensor == model.tensors().end()) { throw std::runtime_error("Tensor not found"); }
    if (tensor->dimensions.size() != 2) { throw std::runtime_error("Choose a two-dimensional tensor"); }
    if (tensor->dimensions[0] > 1048576 || tensor->dimensions[1] > 1048576 || tensor->size > 268435456) {
        throw std::runtime_error("Tensor exceeds prototype benchmark limits");
    }
    const auto columns = static_cast<std::size_t>(tensor->dimensions[0]);
    const auto rows = static_cast<std::size_t>(tensor->dimensions[1]);
    std::vector<float> input(columns);
    std::vector<float> output(rows);
    for (std::size_t i = 0; i < columns; ++i) { input[i] = static_cast<float>(static_cast<int>(i % 17) - 8) / 8; }
    const auto weights = model.data(*tensor);
    const auto warm = Clock::now();
    stellan::matvec(tensor->type, weights, rows, input, output);
    const auto first_ms = milliseconds(warm);
    std::vector<double> samples;
    for (unsigned i = 0; i < repetitions; ++i) {
        if (cancelled) { return 130; }
        const auto iteration = Clock::now();
        stellan::matvec(tensor->type, weights, rows, input, output);
        samples.push_back(milliseconds(iteration));
    }
    std::sort(samples.begin(), samples.end());
    double checksum = 0;
    for (const auto value : output) { checksum += value; }
    if (!std::isfinite(checksum)) { throw std::runtime_error("Non-finite benchmark output; check model weights"); }
    std::cout << "{\"runtime\":\"stellan-native-prototype\",\"scope\":\"single-thread-matvec-only\",\"tensor\":"
              << stellan::json_string(tensor->name) << ",\"type\":" << tensor->type << ",\"load_ms\":" << load_ms
              << ",\"first_matvec_ms\":" << first_ms << ",\"median_matvec_ms\":" << samples[samples.size() / 2]
              << ",\"matrix_bytes\":" << weights.size() << ",\"repetitions\":" << repetitions
              << ",\"output_checksum\":" << checksum << "}\n";
    return cancelled ? 130 : 0;
}
}

int entry(int argc, char **argv) {
    std::signal(SIGINT, interrupt);
    try {
        return run(argc, argv);
    } catch (const std::exception &error) {
        std::cerr << "stellan-runtime: " << error.what() << '\n';
        return 1;
    }
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
    std::vector<std::string> storage;
    for (int i = 0; i < argc; ++i) {
        const auto utf8 = std::filesystem::path(argv[i]).u8string();
        storage.emplace_back(reinterpret_cast<const char *>(utf8.data()), utf8.size());
    }
    std::vector<char *> args;
    for (auto &value : storage) { args.push_back(value.data()); }
    return entry(argc, args.data());
}
#else
int main(int argc, char **argv) { return entry(argc, argv); }
#endif
