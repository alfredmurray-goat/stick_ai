#pragma once
#include <string>
#include <string_view>
#include <vector>

namespace stellan::agent {
struct Message { std::string role, content; };
/** Smart compaction (src/agent/index.ts compactHistory): returns how many earlier tasks were summarised. */
std::size_t compact_history(std::vector<Message> &messages, double budget);
// JavaScript string helpers over UTF-8 (lone surrogates kept as 3-byte WTF-8), counted in UTF-16 units like JS.
std::size_t js_length(std::string_view s);
std::string js_slice(std::string_view s, std::size_t begin, std::size_t end);
std::string js_trim(std::string_view s);
std::string js_collapse_space(std::string_view s); // .replace(/\s+/g, " ")
}
