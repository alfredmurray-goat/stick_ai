#include "agent_core.hpp"
#include "json.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace stellan::agent {
namespace {
const std::string summary_mark = "<conversation_summary>";
const std::string context_mark = "\n\n<project_context>\n";

struct Unit { std::size_t offset, size; std::uint32_t code; };
// Decodes UTF-8/WTF-8 into code points with their byte spans.
std::vector<Unit> decode(std::string_view s) {
    std::vector<Unit> out;
    for (std::size_t i = 0; i < s.size();) {
        const auto c = static_cast<unsigned char>(s[i]);
        std::size_t n = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 1;
        if (i + n > s.size()) { n = 1; }
        std::uint32_t code = n == 1 ? c : n == 2 ? (c & 0x1F) : n == 3 ? (c & 0x0F) : (c & 0x07);
        for (std::size_t k = 1; k < n; ++k) { code = (code << 6) | (static_cast<unsigned char>(s[i + k]) & 0x3F); }
        out.push_back({i, n, code});
        i += n;
    }
    return out;
}
bool js_space(std::uint32_t c) {
    return c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D || c == 0x20 || c == 0xA0 || c == 0x1680 ||
           (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
}
std::string encode(std::uint32_t c) {
    std::string out;
    if (c < 0x80) { out += static_cast<char>(c); }
    else if (c < 0x800) { out += static_cast<char>(0xC0 | (c >> 6)); out += static_cast<char>(0x80 | (c & 0x3F)); }
    else if (c < 0x10000) { out += static_cast<char>(0xE0 | (c >> 12)); out += static_cast<char>(0x80 | ((c >> 6) & 0x3F)); out += static_cast<char>(0x80 | (c & 0x3F)); }
    else { out += static_cast<char>(0xF0 | (c >> 18)); out += static_cast<char>(0x80 | ((c >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((c >> 6) & 0x3F)); out += static_cast<char>(0x80 | (c & 0x3F)); }
    return out;
}
std::size_t utf8_bytes(std::string_view s) { return s.size(); } // Buffer.byteLength: WTF-8 lone surrogates count 3, as U+FFFD does
bool starts_with(std::string_view s, std::string_view p) { return s.substr(0, p.size()) == p; }
}

std::size_t js_length(std::string_view s) {
    std::size_t n = 0;
    for (const auto &u : decode(s)) { n += u.code >= 0x10000 ? 2 : 1; }
    return n;
}
std::string js_slice(std::string_view s, std::size_t begin, std::size_t end) {
    std::string out;
    std::size_t at = 0;
    for (const auto &u : decode(s)) {
        if (u.code >= 0x10000) {
            const std::uint32_t high = 0xD800 + ((u.code - 0x10000) >> 10), low = 0xDC00 + ((u.code - 0x10000) & 0x3FF);
            const bool a = at >= begin && at < end, b = at + 1 >= begin && at + 1 < end;
            if (a && b) { out.append(s.substr(u.offset, u.size)); }
            else if (a) { out += encode(high); }
            else if (b) { out += encode(low); }
            at += 2;
        } else {
            if (at >= begin && at < end) { out.append(s.substr(u.offset, u.size)); }
            ++at;
        }
    }
    return out;
}
std::string js_trim(std::string_view s) {
    const auto units = decode(s);
    std::size_t first = 0, last = units.size();
    while (first < last && js_space(units[first].code)) { ++first; }
    while (last > first && js_space(units[last - 1].code)) { --last; }
    if (first == last) { return ""; }
    return std::string(s.substr(units[first].offset, units[last - 1].offset + units[last - 1].size - units[first].offset));
}
std::string js_collapse_space(std::string_view s) {
    std::string out;
    bool in_space = false;
    for (const auto &u : decode(s)) {
        if (js_space(u.code)) { if (!in_space) { out += ' '; } in_space = true; }
        else { out.append(s.substr(u.offset, u.size)); in_space = false; }
    }
    return out;
}

namespace {
bool is_task(const Message &m) { return m.role == "user" && !starts_with(m.content, "<tool_result>") && !starts_with(m.content, summary_mark); }
std::size_t total(const std::vector<Message> &messages, std::size_t from = 0) {
    std::size_t sum = 0;
    for (std::size_t i = from; i < messages.size(); ++i) { sum += utf8_bytes(messages[i].content); }
    return sum;
}
std::string js_string(const json::Value *value) {
    if (!value) { return "undefined"; }
    if (value->is_null()) { return "null"; }
    if (value->is_string()) { return value->string(); }
    if (value->is_object()) { return "[object Object]"; }
    if (value->is_array()) {
        std::string out;
        bool first = true;
        for (const auto &item : value->array()) { if (!first) { out += ','; } first = false; if (!item.is_null()) { out += js_string(&item); } }
        return out;
    }
    return json::stringify(*value);
}
std::string summary_of(const std::vector<Message> &turn) {
    const auto &first = turn[0].content;
    const auto mark = first.find(context_mark);
    const auto task = js_trim(js_collapse_space(mark == std::string::npos ? first : first.substr(0, mark)));
    std::vector<std::string> steps;
    std::string answer;
    for (std::size_t m = 1; m < turn.size(); ++m) {
        if (turn[m].role != "assistant") { continue; }
        const auto &content = turn[m].content;
        for (std::size_t at = 0;;) {
            const auto open = content.find("<tool_call>", at);
            if (open == std::string::npos) { break; }
            const auto close = content.find("</tool_call>", open + 11);
            if (close == std::string::npos) { break; }
            try {
                const auto call = json::parse(content.substr(open + 11, close - open - 11));
                const json::Value *arguments = call.find("arguments");
                // call.arguments?.path ?? .query ?? .command: the first that exists and is not null.
                const json::Value *target = nullptr;
                if (arguments && arguments->is_object()) {
                    for (const char *key : {"path", "query", "command"}) {
                        if (const auto *v = arguments->find(key); v && !v->is_null()) { target = v; break; }
                    }
                }
                std::string step = js_string(call.find("name"));
                if (target && target->is_string()) { step += " " + js_slice(target->string(), 0, 80); }
                steps.push_back(std::move(step));
            } catch (const std::exception &) {}
            at = close + 12;
        }
        if (const auto open = content.find("<done>"); open != std::string::npos) {
            const auto close = content.find("</done>", open + 6);
            answer = js_trim(js_collapse_space(content.substr(open + 6, close == std::string::npos ? std::string::npos : close - open - 6)));
        }
    }
    std::vector<std::string> unique;
    for (auto &step : steps) { if (std::find(unique.begin(), unique.end(), step) == unique.end()) { unique.push_back(step); } }
    std::string out = "- The user asked: \"" + js_slice(task, 0, 300) + (js_length(task) > 300 ? "…" : "") + "\"";
    if (!unique.empty()) {
        out += "\n  You used: ";
        for (std::size_t i = 0; i < std::min<std::size_t>(unique.size(), 12); ++i) { out += (i ? "; " : "") + unique[i]; }
        if (unique.size() > 12) { out += "; …"; }
    }
    if (!answer.empty()) { out += "\n  Your answer: " + js_slice(answer, 0, 400) + (js_length(answer) > 400 ? "…" : ""); }
    return out;
}
}

std::size_t compact_history(std::vector<Message> &messages, double budget) {
    if (static_cast<double>(total(messages)) <= budget) { return 0; }
    std::vector<std::size_t> starts;
    for (std::size_t i = 0; i < messages.size(); ++i) { if (is_task(messages[i])) { starts.push_back(i); } }
    if (starts.size() < 2) { return 0; }
    std::size_t keep_from = starts.back();
    for (std::size_t i = starts.size() - 1; i-- > 0;) {
        if (static_cast<double>(total(messages, starts[i])) > budget / 2) { break; }
        keep_from = starts[i];
    }
    std::vector<std::string> lines_list;
    for (std::size_t i = 0; i < keep_from; ++i) {
        const auto &m = messages[i];
        if (m.role == "user" && starts_with(m.content, summary_mark)) {
            std::string body = m.content.substr(summary_mark.size());
            if (const auto end = body.find("</conversation_summary>"); end != std::string::npos) { body.erase(end); }
            if (starts_with(body, "Earlier in this conversation")) {
                const auto newline = body.find('\n');
                if (newline != std::string::npos) { body.erase(0, newline + 1); }
            }
            lines_list.push_back(js_trim(body));
        }
    }
    std::vector<std::vector<Message>> turns;
    for (std::size_t i = 0; i < keep_from; ++i) {
        const auto &m = messages[i];
        if (is_task(m)) { turns.push_back({m}); }
        else if (!turns.empty() && !starts_with(m.content, summary_mark)) { turns.back().push_back(m); }
    }
    if (turns.empty()) { return 0; }
    for (const auto &turn : turns) { lines_list.push_back(summary_of(turn)); }
    std::string lines;
    for (std::size_t i = 0; i < lines_list.size(); ++i) { lines += (i ? "\n" : "") + lines_list[i]; }
    if (static_cast<double>(utf8_bytes(lines)) > budget / 4) {
        const auto keep = static_cast<std::size_t>(std::floor(budget / 4));
        const auto length = js_length(lines);
        lines = "…\n" + (keep == 0 ? lines : js_slice(lines, length > keep ? length - keep : 0, length));
    }
    std::vector<Message> rest(messages.begin() + static_cast<std::ptrdiff_t>(keep_from), messages.end());
    messages = {{"user", summary_mark + "Earlier in this conversation (summarised to save memory; read files again for their exact contents):\n" + lines + "</conversation_summary>"},
                {"assistant", "<done>Noted. I'll re-read files when I need their exact contents.</done>"}};
    messages.insert(messages.end(), rest.begin(), rest.end());
    return turns.size();
}
}
