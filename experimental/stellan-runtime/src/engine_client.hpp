#pragma once
#include "agent_core.hpp"
#include "json.hpp"
#include <functional>
#include <string>
#include <vector>

namespace stellan::engine {
/** boundedToolHistory (src/agent/context.ts): trims old tool output in half-limit steps so the prompt cache holds. */
std::vector<agent::Message> bounded_tool_history(const std::vector<agent::Message> &messages, double limit);
struct Reply { std::string content; bool summary_streamed = false; };
/** One streamed chat completion from the local engine, the same request and stream handling as src/model/ollama.ts. */
struct Client {
    int port = 0;
    std::string key, system;
    json::Value options; // model, grammar, temperature, cache_prompt, ... (everything in the body except messages)
    double history_bytes = 1e18;
    std::vector<std::string> tools;
    Reply complete(const std::vector<agent::Message> &messages, const std::function<void(std::string_view, bool)> &emit, const std::function<void(double)> &usage) const;
};
}
