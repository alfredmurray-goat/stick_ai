#pragma once
#include <string>
#include <string_view>
#include <functional>
#include <optional>
#include <vector>

namespace stellan::agent {
struct Message { std::string role, content; };
struct Activity { std::size_t step; std::string phase, tool; std::optional<std::string> path, detail, result; };
/** Everything the loop needs from outside: the model, tools and the app. Tool errors are thrown as exceptions. */
struct LoopIO {
    std::function<std::string(const std::vector<Message> &)> complete; // messages without the system message
    std::function<std::string(const std::string &name, const std::string &arguments)> execute;
    std::function<void(const std::string &, bool)> emit;
    std::function<void(const std::string &)> log;
    std::function<void(const std::vector<Message> &)> save;
    std::function<void(const Activity &)> activity;
};
/** What the app knows about Max for this session (src/agent/delegate.ts); this port runs without a loaded Max. */
struct Specialist { double total_bytes = 0, recommended_bytes = 0; bool no_swap = false; };
/** The agent loop (src/agent/index.ts runAgent) for a session without Max, project context or hooks yet. */
std::string run_agent(const std::string &task, std::vector<Message> &messages, std::size_t max_steps, const std::string &task_instructions, double history_bytes, const std::vector<std::string> &tool_names, const Specialist &specialist, LoopIO &io);
/** Smart compaction (src/agent/index.ts compactHistory): returns how many earlier tasks were summarised. */
std::size_t compact_history(std::vector<Message> &messages, double budget);
// JavaScript string helpers over UTF-8 (lone surrogates kept as 3-byte WTF-8), counted in UTF-16 units like JS.
std::size_t js_length(std::string_view s);
std::string js_slice(std::string_view s, std::size_t begin, std::size_t end);
std::string js_trim(std::string_view s);
std::string js_collapse_space(std::string_view s); // .replace(/\s+/g, " ")
}
