#pragma once
#include <string>
#include <string_view>

namespace stellan {
/** Completion boundaries only; JSON/tool validation and approvals remain with the caller. */
class TaggedStop {
    enum class Mode { text, think, tool, done };
    Mode mode_ = Mode::text, resume_ = Mode::text;
    std::string suffix_, root_;
    bool complete_ = false;
public:
    bool allows(std::string_view text) const {
        auto next = *this;
        for (const char c : text) {
            if (next.mode_ == Mode::text) {
                auto root = next.root_ + c;
                const auto first = root.find_first_not_of(" \t\r\n");
                if (first == std::string::npos) { if (root.size() > 16) return false; }
                else {
                    if (first > 16) return false;
                    const auto prefix = std::string_view(root).substr(first);
                    if (!std::string_view("<think>").starts_with(prefix) && !std::string_view("<tool_call>").starts_with(prefix) && !std::string_view("<done>").starts_with(prefix)) return false;
                }
            }
            next.push(std::string_view(&c, 1));
        }
        return true;
    }
    bool push(std::string_view text) {
        for (const char c : text) {
            if (complete_) break;
            if (mode_ == Mode::text) { root_ += c; if (root_.size() > 32) root_.erase(0, root_.size() - 32); }
            suffix_ += c;
            if (suffix_.size() > 12) suffix_.erase(0, suffix_.size() - 12);
            if ((mode_ == Mode::text || mode_ == Mode::done) && suffix_.ends_with("<think>")) {
                resume_ = mode_; mode_ = Mode::think; suffix_.clear(); root_.clear();
            } else if (mode_ == Mode::think && suffix_.ends_with("</think>")) { mode_ = resume_; suffix_.clear(); root_.clear(); }
            else if (mode_ == Mode::text && suffix_.ends_with("<tool_call>")) { mode_ = Mode::tool; suffix_.clear(); root_.clear(); }
            else if (mode_ == Mode::text && suffix_.ends_with("<done>")) { mode_ = Mode::done; suffix_.clear(); root_.clear(); }
            else if ((mode_ == Mode::tool && suffix_.ends_with("</tool_call>")) || (mode_ == Mode::done && suffix_.ends_with("</done>"))) complete_ = true;
        }
        return complete_;
    }
};
}
