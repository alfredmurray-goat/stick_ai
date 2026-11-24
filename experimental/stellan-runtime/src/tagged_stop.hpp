#pragma once
#include <string>
#include <string_view>

namespace stellan {
/** Completion boundaries only; JSON/tool validation and approvals remain with the caller. */
class TaggedStop {
    enum class Mode { text, think, tool, done };
    Mode mode_ = Mode::text, resume_ = Mode::text;
    std::string suffix_;
    bool complete_ = false;
public:
    bool push(std::string_view text) {
        for (const char c : text) {
            if (complete_) break;
            suffix_ += c;
            if (suffix_.size() > 12) suffix_.erase(0, suffix_.size() - 12);
            if ((mode_ == Mode::text || mode_ == Mode::done) && suffix_.ends_with("<think>")) {
                resume_ = mode_; mode_ = Mode::think; suffix_.clear();
            } else if (mode_ == Mode::think && suffix_.ends_with("</think>")) { mode_ = resume_; suffix_.clear(); }
            else if (mode_ == Mode::text && suffix_.ends_with("<tool_call>")) { mode_ = Mode::tool; suffix_.clear(); }
            else if (mode_ == Mode::text && suffix_.ends_with("<done>")) { mode_ = Mode::done; suffix_.clear(); }
            else if ((mode_ == Mode::tool && suffix_.ends_with("</tool_call>")) || (mode_ == Mode::done && suffix_.ends_with("</done>"))) complete_ = true;
        }
        return complete_;
    }
};
}
