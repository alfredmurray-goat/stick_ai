#include "llama.h"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <iostream>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#endif

namespace {
unsigned number(const char *text, unsigned maximum) {
    const std::string value(text);
    unsigned result = 0;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
    if (parsed.ec != std::errc() || parsed.ptr != value.data() + value.size() || result == 0 || result > maximum) { throw std::runtime_error("Invalid benchmark option"); }
    return result;
}
using Clock = std::chrono::steady_clock;
double ms(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }
struct Usage { double cpu; std::uint64_t peak; };
Usage usage() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS memory {};
    FILETIME created, exited, kernel, user;
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &memory, static_cast<DWORD>(sizeof(memory))) || !GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) { throw std::runtime_error("Cannot measure process resources"); }
    const auto ticks = [](FILETIME time) { return (static_cast<std::uint64_t>(time.dwHighDateTime) << 32) | time.dwLowDateTime; };
    return {static_cast<double>(ticks(kernel) + ticks(user)) / 10000, static_cast<std::uint64_t>(memory.PeakWorkingSetSize)};
#else
    struct rusage result {};
    if (getrusage(RUSAGE_SELF, &result) != 0) { throw std::runtime_error("Cannot measure process resources"); }
    const auto cpu = static_cast<double>(result.ru_utime.tv_sec + result.ru_stime.tv_sec) * 1000 + static_cast<double>(result.ru_utime.tv_usec + result.ru_stime.tv_usec) / 1000;
#ifdef __APPLE__
    return {cpu, static_cast<std::uint64_t>(result.ru_maxrss)};
#else
    return {cpu, static_cast<std::uint64_t>(result.ru_maxrss) * 1024};
#endif
#endif
}
}

int main(int argc, char **argv) {
    llama_model *model = nullptr;
    llama_context *context = nullptr;
    try {
        if (argc != 5 && argc != 6) { throw std::runtime_error("Usage: reference MODEL TOKENS THREADS CONTEXT [no-repack]; input token IDs on stdin"); }
        const auto count = number(argv[2], 4096);
        const auto threads = number(argv[3], 64);
        const auto ctx = number(argv[4], 32768);
        std::string line;
        if (!std::getline(std::cin, line) || line.size() > 1048576) { throw std::runtime_error("Missing or oversized prompt token IDs"); }
        std::vector<llama_token> ids;
        std::size_t cursor = 0;
        while (cursor < line.size()) {
            const auto end = line.find(',', cursor);
            const auto stop = end == std::string::npos ? line.size() : end;
            llama_token token = -1;
            const auto parsed = std::from_chars(line.data() + cursor, line.data() + stop, token);
            if (parsed.ec != std::errc() || parsed.ptr != line.data() + stop || token < 0) { throw std::runtime_error("Invalid prompt token ID"); }
            ids.push_back(token);
            if (ids.size() > 32768) { throw std::runtime_error("Too many prompt tokens"); }
            if (end == std::string::npos) { break; }
            cursor = end + 1;
        }
        if (ids.empty()) { throw std::runtime_error("Prompt is empty"); }
        llama_backend_init();
        auto parameters = llama_model_default_params();
        parameters.n_gpu_layers = 0;
        parameters.use_extra_bufts = argc == 5;
        if (argc == 6 && std::string(argv[5]) != "no-repack") { throw std::runtime_error("Unknown benchmark switch"); }
        model = llama_model_load_from_file(argv[1], parameters);
        if (model == nullptr) { throw std::runtime_error("Reference model load failed"); }
        if (!std::all_of(ids.begin(), ids.end(), [&](auto id) { return id < llama_vocab_n_tokens(llama_model_get_vocab(model)); })) { throw std::runtime_error("Prompt token exceeds vocabulary"); }
        auto settings = llama_context_default_params();
        settings.n_ctx = ctx;
        settings.n_batch = 512;
        settings.n_ubatch = 256;
        settings.n_seq_max = 1;
        settings.n_threads = static_cast<std::int32_t>(threads);
        settings.n_threads_batch = static_cast<std::int32_t>(threads);
        context = llama_init_from_model(model, settings);
        if (context == nullptr) { throw std::runtime_error("Reference context failed"); }
        const auto start = Clock::now();
        const auto cpu_start = usage().cpu;
        for (std::size_t offset = 0; offset < ids.size(); offset += 512) {
            const auto size = static_cast<std::int32_t>(std::min<std::size_t>(512, ids.size() - offset));
            if (llama_decode(context, llama_batch_get_one(ids.data() + offset, size)) != 0) { throw std::runtime_error("Reference prompt failed"); }
        }
        const auto prompt_ms = ms(start);
        const auto decode_start = Clock::now();
        unsigned generated = 0;
        const auto *vocabulary = llama_model_get_vocab(model);
        const auto vocabulary_size = llama_vocab_n_tokens(vocabulary);
        for (unsigned i = 0; i < count; ++i) {
            const auto *logits = llama_get_logits_ith(context, -1);
            std::vector<llama_token> top(static_cast<std::size_t>(vocabulary_size));
            std::iota(top.begin(), top.end(), 0);
            const auto kept = std::min<std::size_t>(10, top.size());
            std::partial_sort(top.begin(), top.begin() + static_cast<std::ptrdiff_t>(kept), top.end(), [&](auto a, auto b) { return logits[a] > logits[b]; });
            std::cout << "{\"event\":\"token\",\"id\":" << top[0] << ",\"top\":[";
            for (std::size_t j = 0; j < kept; ++j) { if (j != 0) { std::cout << ','; } std::cout << "{\"id\":" << top[j] << ",\"logit\":" << logits[top[j]] << '}'; }
            std::cout << "]}\n" << std::flush;
            ++generated;
            if (llama_vocab_is_eog(vocabulary, top[0]) || i + 1 == count) { break; }
            auto next = top[0];
            if (llama_decode(context, llama_batch_get_one(&next, 1)) != 0) { throw std::runtime_error("Reference decode failed"); }
        }
        std::cout << "{\"event\":\"finished\",\"prompt_ms\":" << prompt_ms << ",\"decode_ms\":" << ms(decode_start) << ",\"generated\":" << generated << ",\"repack\":" << (parameters.use_extra_bufts ? "true" : "false") << ",\"cpu_only\":true,\"cpu_ms\":" << usage().cpu - cpu_start << ",\"peak_rss_bytes\":" << usage().peak << "}\n";
        llama_free(context);
        llama_model_free(model);
        llama_backend_free();
        return 0;
    } catch (const std::exception &error) {
        if (context != nullptr) { llama_free(context); }
        if (model != nullptr) { llama_model_free(model); }
        llama_backend_free();
        std::cerr << error.what() << '\n';
        return 1;
    }
}
