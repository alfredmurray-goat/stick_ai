#include "protocol.hpp"
#include "json.hpp"

#include <algorithm>
#include <array>
#include <stdexcept>

namespace stellan::protocol {
namespace {
bool starts_with(std::string_view text, std::size_t at, std::string_view token) { return text.substr(at, token.size()) == token; }
// JavaScript's String(value) for a parsed JSON value, used in the unknown-tool message.
std::string js_string(const json::Value &value) {
    if (value.is_null()) { return "null"; }
    if (value.is_string()) { return value.string(); }
    if (value.is_object()) { return "[object Object]"; }
    if (value.is_array()) {
        std::string out;
        bool first = true;
        for (const auto &item : value.array()) { if (!first) { out += ','; } first = false; if (!item.is_null()) { out += js_string(item); } }
        return out;
    }
    return json::stringify(value);
}
}

void TaggedStream::output(std::string_view text) {
    content += text;
    if (!text.empty() && (mode_ == Mode::text || mode_ == Mode::think || mode_ == Mode::done)) { emit_(text, mode_ == Mode::think); }
}

void TaggedStream::push(std::string_view text) {
    if (complete) { return; }
    pending_ += text;
    while (!pending_.empty() && !complete) {
        std::vector<std::string_view> tags;
        if (mode_ == Mode::text) { tags = {"<think>", "<tool_call>", "<done>"}; }
        else if (mode_ == Mode::think) { tags = {"</think>"}; }
        else if (mode_ == Mode::tool) { tags = {"</tool_call>"}; }
        else { tags = {"<think>", "</done>"}; }
        std::size_t best = std::string::npos;
        std::string_view found;
        for (const auto tag : tags) {
            const auto index = pending_.find(tag);
            if (index != std::string::npos && index < best) { best = index; found = tag; }
        }
        if (best != std::string::npos) {
            output(std::string_view(pending_).substr(0, best));
            content += found;
            pending_.erase(0, best + found.size());
            if (found == "<think>") { resume_ = mode_ == Mode::done ? Mode::done : Mode::text; mode_ = Mode::think; }
            else if (found == "</think>") { mode_ = resume_; }
            else if (found == "<tool_call>") { mode_ = Mode::tool; }
            else if (found == "<done>") { mode_ = Mode::done; }
            else { complete = true; pending_.clear(); }
        } else {
            // Hold back a possible partial tag at the end so it is never shown as text.
            std::size_t longest = 0;
            for (const auto tag : tags) { longest = std::max(longest, tag.size()); }
            std::size_t keep = std::min(longest - 1, pending_.size());
            while (keep && !std::any_of(tags.begin(), tags.end(), [&](std::string_view tag) { return tag.substr(0, keep) == std::string_view(pending_).substr(pending_.size() - keep); })) { --keep; }
            const auto length = pending_.size() - keep;
            output(std::string_view(pending_).substr(0, length));
            pending_.erase(0, length);
            break;
        }
    }
}

void TaggedStream::finish() {
    if (!complete) { output(pending_); pending_.clear(); }
}

Parsed parse_step(std::string_view raw, const std::vector<std::string> &tool_names) {
    TaggedStream parser([](std::string_view, bool) {});
    parser.push(raw);
    parser.finish();
    const std::string text = parser.content;
    std::string tool, summary;
    enum class Mode { text, think, tool, done } mode = Mode::text, resume = Mode::text;
    const auto known = [&](const std::string &name) { return std::find(tool_names.begin(), tool_names.end(), name) != tool_names.end(); };
    std::string allowed;
    for (std::size_t i = 0; i < tool_names.size(); ++i) { allowed += (i ? ", " : "") + tool_names[i]; }
    for (std::size_t index = 0; index < text.size();) {
        const std::string_view token = mode == Mode::think ? "</think>" : mode == Mode::tool ? "</tool_call>" : mode == Mode::done ? "</done>" : "";
        if (!token.empty() && starts_with(text, index, token)) {
            index += token.size();
            if (mode == Mode::think) { mode = resume; continue; }
            if (mode == Mode::done) {
                // A request accidentally wrapped in <done> has not executed: say so, so Lite issues a real tool call.
                try {
                    const auto candidate = json::parse(summary);
                    if (candidate.is_object() && candidate.object().size() == 2) {
                        const auto *name = candidate.find("name");
                        const auto *arguments = candidate.find("arguments");
                        if (name && name->is_string() && known(name->string()) && arguments && arguments->is_object()) {
                            return {text, {Step::Kind::error, "", "", "", "A tool request inside <done> did not execute. Send that JSON inside <tool_call>...</tool_call>, wait for <tool_result>, then write a plain-language <done> summary based on the result."}};
                        }
                    }
                } catch (const std::exception &) {}
                return {text, {Step::Kind::done, "", "", summary, ""}};
            }
            try {
                const auto value = json::parse(tool);
                if (!value.is_object()) { throw std::runtime_error("Tool call must be a JSON object"); }
                const auto *name = value.find("name");
                if (!name || !name->is_string() || !known(name->string())) {
                    const std::string shown = name ? js_string(*name) : "undefined";
                    throw std::runtime_error("Unknown tool name: " + shown + ". Allowed: " + allowed);
                }
                const auto *arguments = value.find("arguments");
                if (!arguments || !arguments->is_object()) { throw std::runtime_error("Tool arguments must be a JSON object"); }
                return {text, {Step::Kind::call, name->string(), json::stringify(*arguments), "", ""}};
            } catch (const std::exception &error) {
                return {text, {Step::Kind::error, "", "", "", std::string("Invalid tool call: ") + error.what()}};
            }
        }
        if ((mode == Mode::text || mode == Mode::done) && starts_with(text, index, "<think>")) { resume = mode; mode = Mode::think; index += 7; continue; }
        if (mode == Mode::text && starts_with(text, index, "<tool_call>")) { mode = Mode::tool; index += 11; continue; }
        if (mode == Mode::text && starts_with(text, index, "<done>")) { mode = Mode::done; index += 6; continue; }
        if (mode == Mode::tool) { tool += text[index]; }
        else if (mode == Mode::done) { summary += text[index]; }
        ++index;
    }
    return {text, {Step::Kind::error, "", "", "", "Expected one complete <tool_call> JSON block or a <done> summary. If finished, repeat your answer inside <done>Your final summary</done>, including both tags. If a tool is needed, send a JSON object with name and arguments inside <tool_call>...</tool_call> using the appropriate tool and arguments, then wait for its result. Plain text without these tags is not a completed step."}};
}
}
