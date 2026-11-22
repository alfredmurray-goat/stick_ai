#include "session.hpp"
#include "lite.hpp"
#include "max.hpp"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string_view>

namespace stellan {
namespace {
using Clock = std::chrono::steady_clock;
double elapsed(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }
unsigned number(std::string_view text, unsigned maximum) {
    unsigned value = 0;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    if (parsed.ec != std::errc() || parsed.ptr != text.data() + text.size() || value == 0 || value > maximum) {
        throw std::runtime_error("Invalid session numeric option");
    }
    return value;
}
bool read_line(std::string &line) {
    line.clear();
    char c;
    while (std::cin.get(c)) {
        if (c == '\n') { return true; }
        if (line.size() >= 4194304) { throw std::runtime_error("Session request exceeds limit"); }
        line += c;
    }
    if (!line.empty()) { throw std::runtime_error("Incomplete session request"); }
    return false;
}
std::vector<std::int32_t> ids(std::string_view csv, std::size_t vocabulary, std::size_t context) {
    std::vector<std::int32_t> result;
    while (!csv.empty()) {
        const auto comma = csv.find(',');
        const auto part = csv.substr(0, comma);
        std::int32_t token = -1;
        const auto parsed = std::from_chars(part.data(), part.data() + part.size(), token);
        if (parsed.ec != std::errc() || parsed.ptr != part.data() + part.size() || token < 0 || static_cast<std::size_t>(token) >= vocabulary) {
            throw std::runtime_error("Invalid session token ID");
        }
        result.push_back(token);
        if (result.size() > context) { throw std::runtime_error("Session context is full"); }
        if (comma == std::string_view::npos) { break; }
        csv.remove_prefix(comma + 1);
        if (csv.empty()) { throw std::runtime_error("Empty session token ID"); }
    }
    if (result.empty()) { throw std::runtime_error("A session prompt is required"); }
    return result;
}
}

int session(int argc, char **argv, const std::function<bool()> &cancelled) {
    const bool force = argc == 7 && std::string_view(argv[6]) == "--force-max";
    if (argc != 6 && !force) { throw std::runtime_error("Usage: serve MODEL SHA256 THREADS CONTEXT [--force-max]"); }
    const auto threads = number(argv[4], 64);
    const auto context = number(argv[5], 262144);
    const auto path = std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(argv[2])));
    const std::string expected(argv[3]);
    if (expected.size() != 64 || !std::all_of(expected.begin(), expected.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) {
        throw std::runtime_error("Supply the trusted lowercase model SHA256");
    }
    const auto initial_size = std::filesystem::file_size(path);
    const auto initial_time = std::filesystem::last_write_time(path);
    const Mapping mapping(path);
    if (mapping.bytes().size() > 8ULL * 1024 * 1024 * 1024 && ram_bytes() < 16ULL * 1024 * 1024 * 1024 && !force) {
        throw std::runtime_error("Stellan-1 Max needs 16 GB RAM or more; explicit --force-max is required");
    }
    if (force) { std::cerr << "Max may be very slow or crash on this computer\n"; }
    const auto verify_start = Clock::now();
    if (sha256(mapping.bytes()) != expected) { throw std::runtime_error("Model hash mismatch; refusing session"); }
    const auto verify_ms = elapsed(verify_start);
    if (std::filesystem::file_size(path) != initial_size || std::filesystem::last_write_time(path) != initial_time) {
        throw std::runtime_error("Model changed during verification");
    }
    const Model model(mapping.bytes());
    const Tokenizer tokenizer(model);
    std::unique_ptr<Decoder> engine;
    if (model.architecture() == "mamba2") { engine = std::make_unique<Lite>(model, threads); }
    else if (model.architecture() == "llama") { engine = std::make_unique<Max>(model, threads, context); }
    else { throw std::runtime_error("Unsupported session architecture"); }
    std::vector<std::int32_t> processed;
    const std::vector<float> *logits = nullptr;
    std::cout << "{\"event\":\"ready\",\"model_sha256\":" << json_string(expected) << ",\"verify_ms\":" << verify_ms
              << ",\"state_bytes\":" << engine->state_bytes() << "}\n" << std::flush;
    std::string line;
    while (!cancelled() && read_line(line)) {
        unsigned request = 0;
        try {
            if (std::filesystem::file_size(path) != initial_size || std::filesystem::last_write_time(path) != initial_time) {
                throw std::runtime_error("Model changed; restart and verify the session");
            }
            const auto first = line.find(' ');
            const auto second = first == std::string::npos ? first : line.find(' ', first + 1);
            if (first == std::string::npos || second == std::string::npos) { throw std::runtime_error("Invalid session request format"); }
            request = number(std::string_view(line).substr(0, first), std::numeric_limits<unsigned>::max());
            const auto limit = number(std::string_view(line).substr(first + 1, second - first - 1), 4096);
            const auto tokens = ids(std::string_view(line).substr(second + 1), model.vocabulary().size(), context);
            if (tokens.size() + limit > context) { throw std::runtime_error("Session context is full"); }
            const bool reuse = !processed.empty() && tokens.size() >= processed.size() && std::equal(processed.begin(), processed.end(), tokens.begin());
            if (!reuse) { engine->reset(); processed.clear(); logits = nullptr; }
            const auto reused = processed.size();
            const auto start = Clock::now();
            const auto cpu_start = usage().cpu_ms;
            if (tokens.size() > reused) {
                logits = &engine->prefill(std::span(tokens).subspan(reused), cancelled, [&](std::size_t completed) {
                    std::cout << "{\"event\":\"prompt_progress\",\"request_id\":" << request << ",\"completed\":" << reused + completed << ",\"total\":" << tokens.size() << "}\n" << std::flush;
                });
                processed = tokens;
            }
            if (!logits) { throw std::runtime_error("Missing session state"); }
            const auto prompt_ms = elapsed(start);
            const auto decode_start = Clock::now();
            unsigned generated = 0;
            for (; generated < limit && !cancelled(); ) {
                const auto token = static_cast<std::int32_t>(std::max_element(logits->begin(), logits->end()) - logits->begin());
                ++generated;
                std::cout << "{\"event\":\"token\",\"request_id\":" << request << ",\"id\":" << token << "}\n" << std::flush;
                if (token == tokenizer.eos() || generated == limit) { break; }
                logits = &engine->step(token, cancelled);
                processed.push_back(token);
            }
            if (cancelled()) { return 130; }
            std::cout << "{\"event\":\"finished\",\"request_id\":" << request << ",\"model_sha256\":" << json_string(expected)
                      << ",\"reused_tokens\":" << reused << ",\"evaluated_prompt_tokens\":" << tokens.size() - reused
                      << ",\"prompt_ms\":" << prompt_ms << ",\"decode_ms\":" << elapsed(decode_start)
                      << ",\"generated\":" << generated << ",\"cpu_ms\":" << usage().cpu_ms - cpu_start
                      << ",\"peak_rss_bytes\":" << usage().peak_rss_bytes << "}\n" << std::flush;
        } catch (const std::exception &error) {
            engine->reset(); processed.clear(); logits = nullptr;
            std::cout << "{\"event\":\"error\",\"request_id\":" << request << ",\"message\":" << json_string(error.what()) << "}\n" << std::flush;
            if (cancelled()) { return 130; }
        }
    }
    return cancelled() ? 130 : 0;
}
}
