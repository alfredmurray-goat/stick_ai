#pragma once
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace stellan::protocol {
/** Lite's tagged reply format (<think>, <tool_call>, <done>), ported from src/model/protocol.ts. */
class TaggedStream {
public:
    explicit TaggedStream(std::function<void(std::string_view, bool)> emit) : emit_(std::move(emit)) {}
    void push(std::string_view text);
    void finish();
    std::string content;
    bool complete = false;
private:
    void output(std::string_view text);
    std::function<void(std::string_view, bool)> emit_;
    std::string pending_;
    enum class Mode { text, think, tool, done } mode_ = Mode::text, resume_ = Mode::text;
};
struct Step {
    enum class Kind { call, done, error } kind = Kind::error;
    std::string name, arguments; // call: tool name and JSON.stringify(arguments)
    std::string summary;         // done
    std::string error;           // error
};
struct Parsed { std::string content; Step step; };
Parsed parse_step(std::string_view content, const std::vector<std::string> &tool_names);
}
