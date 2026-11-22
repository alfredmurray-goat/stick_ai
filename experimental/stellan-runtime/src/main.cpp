#include "runtime.hpp"
#include "lite.hpp"
#include "max.hpp"
#include "session.hpp"

#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <stdexcept>
#include <string_view>

namespace {
std::atomic_bool cancelled {false};
static_assert(std::atomic_bool::is_always_lock_free);
void interrupt(int) { cancelled.store(true, std::memory_order_relaxed); }
using Clock = std::chrono::steady_clock;
double milliseconds(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

unsigned bounded(const char *text, unsigned maximum) {
    unsigned result = 0;
    const std::string_view value(text);
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
    if (parsed.ec != std::errc() || parsed.ptr != value.data() + value.size() || result == 0 || result > maximum) {
        throw std::runtime_error("Numeric option is outside supported limits");
    }
    return result;
}

int generate(int argc, char **argv) {
    const std::string_view mode(argv[1]);
    const bool force_max = argc > 3 && std::string_view(argv[argc - 1]) == "--force-max";
    if (force_max) { --argc; }
    if ((mode == "tokenize" && argc != 4) || (mode != "tokenize" && (argc < 5 || argc > 8))) {
        throw std::runtime_error("Usage: tokenize MODEL PROMPT | generate MODEL SHA256 PROMPT [TOKENS] [THREADS] | decode MODEL SHA256 IDS [TOKENS] [THREADS]");
    }
    const stellan::Mapping mapping(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(argv[2]))));
    if (mode != "tokenize" && mapping.bytes().size() > 8ULL * 1024 * 1024 * 1024 && stellan::ram_bytes() < 16ULL * 1024 * 1024 * 1024) {
        if (!force_max) { throw std::runtime_error("Stellan-1 Max needs 16 GB RAM or more; explicit --force-max is required"); }
        std::cerr << "Max may be very slow or crash on this computer\n";
    }
    double verify_ms = 0;
    if (mode != "tokenize") {
        const std::string expected(argv[3]);
        if (expected.size() != 64 || !std::all_of(expected.begin(), expected.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) {
            throw std::runtime_error("Supply the trusted lowercase SHA256 before generation");
        }
        const auto start = Clock::now();
        if (stellan::sha256(mapping.bytes()) != expected) { throw std::runtime_error("Model hash mismatch; refusing generation"); }
        verify_ms = milliseconds(start);
    }
    const stellan::Model model(mapping.bytes());
    const stellan::Tokenizer tokenizer(model);
    std::vector<std::int32_t> tokens;
    if (mode == "tokenize" || mode == "generate") {
        tokens = tokenizer.encode(argv[mode == "tokenize" ? 3 : 4]);
    } else {
        std::string standard_input;
        if (std::string_view(argv[4]) == "-") {
            char value;
            while (std::cin.get(value) && value != '\n') {
                if (standard_input.size() >= 4194304) { throw std::runtime_error("Token input exceeds limit"); }
                standard_input += value;
            }
        }
        std::string_view ids = std::string_view(argv[4]) == "-" ? standard_input : std::string_view(argv[4]);
        while (!ids.empty()) {
            const auto comma = ids.find(',');
            const auto piece = ids.substr(0, comma);
            std::int32_t token = -1;
            const auto parsed = std::from_chars(piece.data(), piece.data() + piece.size(), token);
            if (parsed.ec != std::errc() || parsed.ptr != piece.data() + piece.size() || token < 0 || static_cast<std::size_t>(token) >= model.vocabulary().size()) {
                throw std::runtime_error("Invalid prompt token ID");
            }
            tokens.push_back(token);
            if (tokens.size() > 262144) { throw std::runtime_error("Prompt exceeds token limit"); }
            if (comma == std::string_view::npos) { break; }
            ids.remove_prefix(comma + 1);
            if (ids.empty()) { throw std::runtime_error("Empty token ID"); }
        }
    }
    if (mode == "tokenize") {
        std::cout << "{\"tokens\":[";
        for (std::size_t i = 0; i < tokens.size(); ++i) { if (i != 0) { std::cout << ','; } std::cout << tokens[i]; }
        std::cout << "]}\n";
        return 0;
    }
    if (tokens.empty()) { throw std::runtime_error("An input token is required"); }
    const auto count = argc >= 6 ? bounded(argv[5], 4096) : 32;
    const auto threads = argc >= 7 ? bounded(argv[6], 64) : 2;
    std::unique_ptr<stellan::Decoder> engine;
    if (model.architecture() == "mamba2") { engine = std::make_unique<stellan::Lite>(model, threads); }
    else if (model.architecture() == "llama") { engine = std::make_unique<stellan::Max>(model, threads, argc >= 8 ? bounded(argv[7], 32768) : 8192); }
    else { throw std::runtime_error("Unsupported model execution architecture"); }
    const auto start = Clock::now();
    const auto cpu_start = stellan::usage().cpu_ms;
    const std::vector<float> *logits = nullptr;
    logits = &engine->prefill(tokens, [] { return cancelled != 0; }, [&](std::size_t completed) {
        std::cout << "{\"event\":\"prompt_progress\",\"completed\":" << completed << ",\"total\":" << tokens.size() << "}\n" << std::flush;
    });
    const auto prompt_ms = milliseconds(start);
    double first_ms = 0;
    std::vector<std::int32_t> generated;
    const auto decode_start = Clock::now();
    for (unsigned i = 0; i < count && !cancelled; ++i) {
        const auto token = static_cast<std::int32_t>(std::max_element(logits->begin(), logits->end()) - logits->begin());
        if (i == 0) { first_ms = milliseconds(start); }
        std::vector<std::size_t> top(logits->size());
        std::iota(top.begin(), top.end(), 0);
        std::partial_sort(top.begin(), top.begin() + std::min<std::size_t>(10, top.size()), top.end(), [&](auto a, auto b) { return (*logits)[a] > (*logits)[b]; });
        std::cout << "{\"event\":\"token\",\"id\":" << token << ",\"text\":" << stellan::json_string(tokenizer.decode(token)) << ",\"top\":[";
        for (std::size_t j = 0; j < std::min<std::size_t>(10, top.size()); ++j) {
            if (j != 0) { std::cout << ','; }
            std::cout << "{\"id\":" << top[j] << ",\"logit\":" << (*logits)[top[j]] << '}';
        }
        std::cout << "]}\n" << std::flush;
        generated.push_back(token);
        if (token == tokenizer.eos() || i + 1 == count) { break; }
        logits = &engine->step(token, [] { return cancelled != 0; });
    }
    std::cout << "{\"event\":\"finished\",\"model_sha256\":" << stellan::json_string(argv[3]) << ",\"verify_ms\":" << verify_ms
              << ",\"prompt_ms\":" << prompt_ms << ",\"first_token_ms\":" << first_ms << ",\"decode_ms\":" << milliseconds(decode_start)
              << ",\"generated\":" << generated.size() << ",\"state_bytes\":" << engine->state_bytes() << ",\"threads\":" << threads
              << ",\"cpu_ms\":" << stellan::usage().cpu_ms - cpu_start << ",\"peak_rss_bytes\":" << stellan::usage().peak_rss_bytes << "}\n";
    return cancelled ? 130 : 0;
}

int run(int argc, char **argv) {
    if (argc >= 2 && std::string_view(argv[1]) == "serve") { return stellan::session(argc, argv, [] { return cancelled.load(std::memory_order_relaxed); }); }
    if (argc == 3 && std::string_view(argv[1]) == "hash") {
        const stellan::Mapping mapping(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(argv[2]))));
        std::cout << "{\"sha256\":" << stellan::json_string(stellan::sha256(mapping.bytes())) << "}\n";
        return 0;
    }
    if (argc >= 3 && (std::string_view(argv[1]) == "generate" || std::string_view(argv[1]) == "decode" || std::string_view(argv[1]) == "tokenize")) {
        return generate(argc, argv);
    }
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
        std::cout << "{\"runtime\":\"Stellan-Run\",\"generation_supported\":false,\"architecture\":"
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
    std::cout << "{\"runtime\":\"Stellan-Run\",\"scope\":\"single-thread-matvec-only\",\"tensor\":"
              << stellan::json_string(tensor->name) << ",\"type\":" << tensor->type << ",\"load_ms\":" << load_ms
              << ",\"first_matvec_ms\":" << first_ms << ",\"median_matvec_ms\":" << samples[samples.size() / 2]
              << ",\"matrix_bytes\":" << weights.size() << ",\"repetitions\":" << repetitions
              << ",\"output_checksum\":" << checksum << "}\n";
    return cancelled ? 130 : 0;
}
}

int entry(int argc, char **argv) {
    std::signal(SIGINT, interrupt);
    std::signal(SIGTERM, interrupt);
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
