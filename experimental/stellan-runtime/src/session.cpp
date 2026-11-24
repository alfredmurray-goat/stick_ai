#include "session.hpp"
#include "lite.hpp"
#include "max.hpp"
#include "host_input.hpp"
#include "tagged_stop.hpp"
#include <optional>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <iostream>
#include <limits>
#include <optional>
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
std::string from_hex(std::string_view encoded) {
    if (encoded.empty() || encoded.size() > 2097152 || encoded.size() % 2) { throw std::runtime_error("Prompt must be bounded UTF-8 hex"); }
    const auto nibble = [](char c) -> unsigned {
        if (c >= '0' && c <= '9') return static_cast<unsigned>(c - '0');
        if (c >= 'a' && c <= 'f') return static_cast<unsigned>(c - 'a' + 10);
        if (c >= 'A' && c <= 'F') return static_cast<unsigned>(c - 'A' + 10);
        throw std::runtime_error("Invalid prompt hex");
    };
    std::string text;
    text.reserve(encoded.size() / 2);
    for (std::size_t i = 0; i < encoded.size(); i += 2) text += static_cast<char>((nibble(encoded[i]) << 4) | nibble(encoded[i + 1]));
    for (std::size_t i = 0; i < text.size(); ++i) {
        const auto first = static_cast<unsigned char>(text[i]);
        if (first < 128) continue;
        const auto count = first >= 0xc2 && first <= 0xdf ? 1U : first >= 0xe0 && first <= 0xef ? 2U : first >= 0xf0 && first <= 0xf4 ? 3U : 0U;
        if (!count || text.size() - i - 1 < count) throw std::runtime_error("Invalid prompt UTF-8");
        unsigned code = first & ((1U << (6 - count)) - 1);
        for (unsigned j = 0; j < count; ++j) {
            const auto next = static_cast<unsigned char>(text[++i]);
            if ((next & 0xc0) != 0x80) throw std::runtime_error("Invalid prompt UTF-8");
            code = (code << 6) | (next & 63);
        }
        const auto minimum = count == 1 ? 128U : count == 2 ? 2048U : 65536U;
        if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw std::runtime_error("Invalid prompt UTF-8");
    }
    return text;
}
std::string to_hex(std::string_view bytes) {
    constexpr char digits[] = "0123456789abcdef";
    std::string text;
    for (const unsigned char c : bytes) { text += digits[c >> 4]; text += digits[c & 15]; }
    return text;
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

int session(int argc, char **argv, const std::function<bool()> &cancelled, SessionOptions options) {
    if (argc < 6) { throw std::runtime_error("Usage: serve MODEL SHA256 THREADS CONTEXT [--force-max] [--split PATH SHA256]"); }
    bool force = false, tagged = false;
    std::filesystem::path split_path;
    std::string split_hash;
    for (int i = 6; i < argc; ++i) {
        const std::string_view option(argv[i]);
        if (option == "--force-max" && !force) force = true;
        else if (option == "--tagged" && !tagged) tagged = true;
        else if (option == "--split" && split_path.empty() && i + 2 < argc) {
            split_path = std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(argv[++i])));
            split_hash = argv[++i];
            if (split_hash.size() != 64 || !std::all_of(split_hash.begin(), split_hash.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) throw std::runtime_error("Invalid split SHA256");
        } else throw std::runtime_error("Unknown session option");
    }
    const auto threads = number(argv[4], 64);
    const auto context = number(argv[5], 262144);
    std::optional<HostInput> host_input;
    if (options.host) host_input.emplace();
    const auto path = std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(argv[2])));
    const std::string expected(argv[3]);
    if (expected.size() != 64 || !std::all_of(expected.begin(), expected.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) {
        throw std::runtime_error("Supply the trusted lowercase model SHA256");
    }
    const auto initial_size = std::filesystem::file_size(path);
    const auto initial_time = std::filesystem::last_write_time(path);
    const Mapping mapping(path);
    std::optional<Mapping> split_mapping;
    std::uintmax_t split_size = 0;
    std::filesystem::file_time_type split_time;
    if (!split_path.empty()) { split_size = std::filesystem::file_size(split_path); split_time = std::filesystem::last_write_time(split_path); split_mapping.emplace(split_path); }
    if (mapping.bytes().size() + split_size > 8ULL * 1024 * 1024 * 1024 && ram_bytes() < 16ULL * 1024 * 1024 * 1024 && !force) {
        throw std::runtime_error("Stellan-1 Max needs 16 GB RAM or more; explicit --force-max is required");
    }
    if (force) { std::cerr << "Max may be very slow or crash on this computer\n"; }
    const auto verify_start = Clock::now();
    if (sha256(mapping.bytes()) != expected) { throw std::runtime_error("Model hash mismatch; refusing session"); }
    if (split_mapping && sha256(split_mapping->bytes()) != split_hash) throw std::runtime_error("Split hash mismatch; refusing session");
    const auto verify_ms = elapsed(verify_start);
    if (std::filesystem::file_size(path) != initial_size || std::filesystem::last_write_time(path) != initial_time) {
        throw std::runtime_error("Model changed during verification");
    }
    Model model(mapping.bytes());
    if (split_mapping) { const Model continuation(split_mapping->bytes(), true); model.attach(continuation); }
    else if (model.has("split.count") && model.number("split.count") > 1) throw std::runtime_error("Supply the verified continuation split");
    if (tagged && model.architecture() != "mamba2") throw std::runtime_error("Tagged completion currently supports Lite only");
    const auto boundary = model.number("tokenizer.ggml.eos_token_id");
    if (boundary < 0 || boundary >= static_cast<double>(model.vocabulary().size()) || std::floor(boundary) != boundary) throw std::runtime_error("Invalid end token");
    const auto eos = static_cast<std::int32_t>(boundary);
    std::optional<Tokenizer> tokenizer;
    if (options.text && (model.architecture() != "mamba2" || model.text("tokenizer.ggml.model") != "llama")) throw std::runtime_error("Native host text currently supports Lite SentencePiece; use --token-ids for Max");
    if (options.host) tokenizer.emplace(model);
    std::unique_ptr<Decoder> engine;
    if (model.architecture() == "mamba2") { engine = std::make_unique<Lite>(model, threads); }
    else if (model.architecture() == "llama") { engine = std::make_unique<Max>(model, threads, context); }
    else { throw std::runtime_error("Unsupported session architecture"); }
    std::vector<std::int32_t> processed;
    const std::vector<float> *logits = nullptr;
    std::cout << "{\"event\":\"ready\",\"model_sha256\":" << json_string(expected) << ",\"verify_ms\":" << verify_ms
              << ",\"native_host\":" << (options.host ? "true" : "false") << ",\"input_mode\":" << json_string(options.text ? "utf8-hex" : "token-ids")
              << ",\"state_bytes\":" << engine->state_bytes() << ",\"state_capacity_bytes\":" << engine->state_capacity_bytes() << ",\"cache_type\":" << stellan::json_string(std::string(engine->cache_type())) << "}\n" << std::flush;
    std::string line;
    while (!cancelled() && (host_input ? host_input->read_line(line, cancelled) : read_line(line))) {
        unsigned request = 0;
        try {
            if (options.host && line == "shutdown") {
                std::cout << "{\"event\":\"stopped\"}\n" << std::flush; break;
            }
            if (options.host && line == "status") {
                std::cout << "{\"event\":\"status\",\"protocol\":1,\"node_required\":false,\"scope\":\"inference-only\",\"state_bytes\":" << engine->state_bytes() << ",\"idle_timeout_seconds\":" << host_input->idle_seconds() << ",\"cached_tokens\":" << processed.size() << "}\n" << std::flush;
                continue;
            }
            if (options.host && line == "reset") {
                engine->reset(); processed.clear(); logits = nullptr;
                std::cout << "{\"event\":\"reset\"}\n" << std::flush; continue;
            }
            if (std::filesystem::file_size(path) != initial_size || std::filesystem::last_write_time(path) != initial_time || (split_mapping && (std::filesystem::file_size(split_path) != split_size || std::filesystem::last_write_time(split_path) != split_time))) {
                throw std::runtime_error("Model changed; restart and verify the session");
            }
            const auto first = line.find(' ');
            const auto second = first == std::string::npos ? first : line.find(' ', first + 1);
            if (first == std::string::npos || second == std::string::npos) { throw std::runtime_error("Invalid session request format"); }
            request = number(std::string_view(line).substr(0, first), std::numeric_limits<unsigned>::max());
            const auto limit = number(std::string_view(line).substr(first + 1, second - first - 1), 4096);
            const auto payload = std::string_view(line).substr(second + 1);
            const auto tokens = options.text ? tokenizer->encode(from_hex(payload), context) : ids(payload, model.vocabulary().size(), context);
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
            TaggedStop boundary_stop;
            bool completed_tag = false;
            for (; generated < limit && !cancelled(); ) {
                auto token = static_cast<std::int32_t>(std::max_element(logits->begin(), logits->end()) - logits->begin());
                if (tagged) {
                    float best = -std::numeric_limits<float>::infinity();
                    token = -1;
                    for (std::size_t candidate = 0; candidate < logits->size(); ++candidate) {
                        if (static_cast<std::int32_t>(candidate) == eos || (*logits)[candidate] <= best || model.token_types()[candidate] == 3) continue;
                        std::string piece = model.vocabulary()[candidate];
                        if (model.token_types()[candidate] == 6) {
                            unsigned byte = 0;
                            if (piece.size() != 6) throw std::runtime_error("Invalid byte fallback token");
                            const auto parsed = std::from_chars(piece.data() + 3, piece.data() + 5, byte, 16);
                            if (parsed.ec != std::errc() || parsed.ptr != piece.data() + 5 || byte > 255) throw std::runtime_error("Invalid byte fallback token");
                            piece.assign(1, static_cast<char>(byte));
                        } else {
                            for (std::size_t pos = 0; (pos = piece.find("▁", pos)) != std::string::npos; ++pos) piece.replace(pos, 3, " ");
                        }
                        if (!piece.empty() && boundary_stop.allows(piece)) { best = (*logits)[candidate]; token = static_cast<std::int32_t>(candidate); }
                    }
                    if (token < 0) throw std::runtime_error("No token satisfies the tagged response boundary");
                }
                ++generated;
                std::cout << "{\"event\":\"token\",\"request_id\":" << request << ",\"id\":" << token;
                if (options.host) std::cout << ",\"bytes_hex\":" << json_string(to_hex(tokenizer->decode(token)));
                std::cout << "}\n" << std::flush;
                if (tagged) {
                    const auto index = static_cast<std::size_t>(token);
                    const auto &piece = model.vocabulary()[index];
                    if (model.token_types()[index] == 6) {
                        unsigned byte = 0;
                        if (piece.size() != 6 || piece.substr(0, 3) != "<0x" || piece[5] != '>') throw std::runtime_error("Invalid byte fallback token");
                        const auto parsed = std::from_chars(piece.data() + 3, piece.data() + 5, byte, 16);
                        if (parsed.ec != std::errc() || parsed.ptr != piece.data() + 5 || byte > 255) throw std::runtime_error("Invalid byte fallback token");
                        const char value = static_cast<char>(byte);
                        completed_tag = boundary_stop.push(std::string_view(&value, 1));
                    } else if (model.token_types()[index] != 3) {
                        std::string decoded = piece;
                        for (std::size_t pos = 0; (pos = decoded.find("▁", pos)) != std::string::npos; ++pos) decoded.replace(pos, 3, " ");
                        completed_tag = boundary_stop.push(decoded);
                    }
                }
                if (token == eos || generated == limit || completed_tag) { break; }
                logits = &engine->step(token, cancelled);
                processed.push_back(token);
            }
            if (cancelled()) { return 130; }
            std::cout << "{\"event\":\"finished\",\"request_id\":" << request << ",\"model_sha256\":" << json_string(expected)
                      << ",\"reused_tokens\":" << reused << ",\"evaluated_prompt_tokens\":" << tokens.size() - reused
                      << ",\"prompt_ms\":" << prompt_ms << ",\"decode_ms\":" << elapsed(decode_start)
                      << ",\"stop_reason\":" << json_string(completed_tag ? "tagged" : generated == limit ? "length" : "eos")
                      << ",\"generated\":" << generated << ",\"cpu_ms\":" << usage().cpu_ms - cpu_start
                      << ",\"peak_rss_bytes\":" << usage().peak_rss_bytes << "}\n" << std::flush;
        } catch (const std::exception &error) {
            engine->reset(); processed.clear(); logits = nullptr;
            std::cout << "{\"event\":\"error\",\"request_id\":" << request << ",\"message\":" << json_string(error.what()) << "}\n" << std::flush;
            if (cancelled()) { return 130; }
        }
    }
    if (host_input && host_input->rested()) std::cout << "{\"event\":\"rested\",\"reason\":\"inactivity\"}\n" << std::flush;
    return cancelled() ? 130 : 0;
}
}
