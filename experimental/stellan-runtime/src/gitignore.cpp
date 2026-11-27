#include "gitignore.hpp"

#include "json.hpp"

#include <cctype>

#include <functional>
#include <iterator>
#include <iostream>
#include <map>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>

// The `ignore` package (7.0.5) that src/portable/github-workspace.ts uses for .gitignore files, ported step by step:
// each pattern goes through the same chain of replacements into the same regular expression, rules are tested in
// the same order with the same negation logic, and a path is ignored when any parent folder is.
namespace stellan::gitignore {
namespace {
using Replacer = std::function<std::string(const std::smatch &, std::size_t index, const std::string &whole)>;
// String.prototype.replace with a function: the first match, or every match for a global expression.
std::string replace(const std::string &input, const std::regex &pattern, bool global, const Replacer &replacer) {
    std::string out; std::size_t at = 0; bool replaced = false;
    for (auto it = std::sregex_iterator(input.begin(), input.end(), pattern); it != std::sregex_iterator(); ++it) {
        const auto &m = *it;
        const auto index = static_cast<std::size_t>(m.position(0));
        out += input.substr(at, index - at);
        out += replacer(m, index, input);
        at = index + static_cast<std::size_t>(m.length(0));
        replaced = true;
        if (!global) { break; }
        if (m.length(0) == 0) { if (at < input.size()) { out += input[at]; } ++at; }
    }
    if (!replaced) { return input; }
    if (at < input.size()) { out += input.substr(at); }
    return out;
}
std::regex re(const char *pattern) { return std::regex(pattern, std::regex::ECMAScript); }
const std::string escape = "\\";

std::string sanitize_range(const std::string &range) {
    static const auto pattern = re("([0-z])-([0-z])");
    return replace(range, pattern, true, [](const std::smatch &m, std::size_t, const std::string &) { return m[1].str()[0] <= m[2].str()[0] ? m[0].str() : std::string(); });
}
std::string clean_range_backslash(const std::string &slashes) { return slashes.substr(0, slashes.size() - slashes.size() % 2); }

// makeRegexPrefix: the REPLACERS chain.
std::string regex_prefix(const std::string &pattern) {
    struct Step { std::regex pattern; bool global; Replacer replacer; };
    static const std::vector<Step> steps = [] {
        std::vector<Step> s;
        s.push_back({re("^\\uFEFF"), false, [](auto &, auto, auto &) { return std::string(); }});
        // Trailing spaces, unless escaped.
        s.push_back({re("((?:\\\\\\\\)*?)(\\\\?\\s+)$"), false, [](const std::smatch &m, auto, auto &) { return m[1].str() + (m[2].str().find('\\') == 0 ? " " : ""); }});
        s.push_back({re("(\\\\+?)\\s"), true, [](const std::smatch &m, auto, auto &) { const auto g = m[1].str(); return g.substr(0, g.size() - g.size() % 2) + " "; }});
        s.push_back({re("[\\\\$.|*+(){^]"), true, [](const std::smatch &m, auto, auto &) { return "\\" + m[0].str(); }});
        s.push_back({re("(?!\\\\)\\?"), true, [](auto &, auto, auto &) { return std::string("[^/]"); }});
        s.push_back({re("^/"), false, [](auto &, auto, auto &) { return std::string("^"); }});
        s.push_back({re("/"), true, [](auto &, auto, auto &) { return std::string("\\/"); }});
        s.push_back({re("^\\^*\\\\\\*\\\\\\*\\\\/"), false, [](auto &, auto, auto &) { return std::string("^(?:.*\\/)?"); }});
        // Patterns without a slash (other than a trailing one) match at any depth.
        s.push_back({re("^(?=[^^])"), false, nullptr});
        s.push_back({re("\\\\/\\\\\\*\\\\\\*(?=\\\\/|$)"), true, [](const std::smatch &, std::size_t index, const std::string &whole) { return index + 6 < whole.size() ? std::string("(?:\\/[^\\/]+)*") : std::string("\\/.+"); }});
        s.push_back({re("(^|[^\\\\]+)(\\\\\\*)+(?=.+)"), true, [](const std::smatch &m, auto, auto &) {
            static const auto star = re("\\\\\\*");
            return m[1].str() + replace(m[2].str(), star, true, [](auto &, auto, auto &) { return std::string("[^\\/]*"); });
        }});
        s.push_back({re("\\\\\\\\\\\\(?=[$.|*+(){^])"), true, [](auto &, auto, auto &) { return escape; }});
        s.push_back({re("\\\\\\\\"), true, [](auto &, auto, auto &) { return escape; }});
        s.push_back({re("(\\\\)?\\[([^\\]/]*?)(\\\\*)($|\\])"), true, [](const std::smatch &m, auto, auto &) {
            const auto lead = m[1].matched ? m[1].str() : std::string(), range = m[2].str(), end = m[3].str(), close = m[4].str();
            if (m[1].matched && lead == escape) { return "\\[" + range + clean_range_backslash(end) + close; }
            if (close == "]") { return end.size() % 2 == 0 ? "[" + sanitize_range(range) + end + "]" : std::string("[]"); }
            return std::string("[]");
        }});
        s.push_back({re("(?:[^*])$"), false, [](const std::smatch &m, auto, auto &) { const auto t = m[0].str(); return !t.empty() && t.back() == '/' ? t + "$" : t + "(?=$|\\/$)"; }});
        return s;
    }();
    std::string value = pattern;
    for (const auto &step : steps) {
        if (!step.replacer) {
            // startingReplacer: depends on the original pattern, not the value so far.
            static const auto inner_slash = re("/(?!$)");
            const auto prefix = std::regex_search(pattern, inner_slash) ? std::string("^") : std::string("(?:^|\\/)");
            value = replace(value, step.pattern, false, [&](auto &, auto, auto &) { return prefix; });
            continue;
        }
        value = replace(value, step.pattern, step.global, step.replacer);
    }
    return value;
}

// JavaScript accepts some legacy forms (Annex B) that std::regex rejects: an escaped letter with no meaning ("\\R" is
// "R"), "\\x" or "\\u" without hex digits (a plain "x" or "u"), "\\c" without a letter, and the empty classes "[]"
// (matches nothing) and "[^]" (matches anything), and a lone "]" or "}". Rewrites them to strict equivalents with the same meaning.
std::string strict(const std::string &js) {
    const auto hex = [&](std::size_t at, std::size_t n) { if (at + n > js.size()) { return false; } for (std::size_t k = 0; k < n; ++k) { if (!std::isxdigit(static_cast<unsigned char>(js[at + k]))) { return false; } } return true; };
    const auto meaningful = std::string("dDsSwWbBfnrtv0");
    std::string out; bool in_class = false;
    for (std::size_t i = 0; i < js.size(); ++i) {
        const char c = js[i];
        if (c == '\\' && i + 1 < js.size()) {
            const char e = js[i + 1];
            if (e == 'x' && !hex(i + 2, 2)) { out += 'x'; ++i; continue; }
            if (e == 'u' && !hex(i + 2, 4)) { out += 'u'; ++i; continue; }
            if (e == 'c' && !(i + 2 < js.size() && std::isalpha(static_cast<unsigned char>(js[i + 2])))) { out += "\\\\c"; ++i; continue; }
            if (std::isalpha(static_cast<unsigned char>(e)) && meaningful.find(e) == std::string::npos && e != 'x' && e != 'u' && e != 'c') { out += e; ++i; continue; }
            if (in_class && e == 'b') { out += "\\x08"; ++i; continue; }
            out += c; out += e; ++i; continue;
        }
        if (!in_class && c == '[') {
            if (js.compare(i, 2, "[]") == 0) { out += "(?!)"; ++i; continue; }
            if (js.compare(i, 3, "[^]") == 0) { out += "[\\s\\S]"; i += 2; continue; }
            in_class = true; out += c;
            if (i + 1 < js.size() && js[i + 1] == '^') { out += '^'; ++i; }
            continue;
        }
        if (in_class && c == ']') { in_class = false; out += c; continue; }
        // A backwards range ("z-a") is an error in JavaScript; libc++ (macOS) would accept it, so refuse it here.
        if (in_class && c == '-' && !out.empty() && out.back() != '[' && i + 1 < js.size() && js[i + 1] != ']' && js[i + 1] != '\\') {
            const char before = out.back(), after = js[i + 1];
            const bool escaped_before = out.size() >= 2 && out[out.size() - 2] == '\\';
            if (!escaped_before && static_cast<unsigned char>(before) > static_cast<unsigned char>(after)) { throw std::regex_error(std::regex_constants::error_range); }
        }
        // A lone "]" or "}" is an ordinary character in JavaScript's legacy syntax; libc++ (macOS) refuses it bare.
        if (!in_class && (c == ']' || c == '}')) { out += '\\'; out += c; continue; }
        out += c;
    }
    return out;
}
// Like the package, a rule's expression is only built when a path first reaches it, so an invalid rule fails then.
struct Rule {
    bool negative = false; std::string source; mutable std::optional<std::regex> regex;
    bool test(const std::string &path) const {
        if (!regex) {
            try { regex.emplace(strict(source), std::regex::ECMAScript | std::regex::icase); }
            catch (const std::regex_error &) { throw std::runtime_error("Invalid regular expression: /" + source + "/i"); }
        }
        return std::regex_search(path, *regex);
    }
};
}

struct Ignore::State { std::vector<Rule> rules; std::map<std::string, std::pair<bool, bool>> cache; };
Ignore::Ignore() : state_(std::make_unique<State>()) {}
Ignore::~Ignore() = default;
Ignore::Ignore(Ignore &&) noexcept = default;
Ignore &Ignore::operator=(Ignore &&) noexcept = default;

void Ignore::add(const std::string &text) {
    static const auto blank = re("^\\s+$"), trailing_backslash = re("(?:[^\\\\]|^)\\\\$");
    std::size_t start = 0; bool added = false;
    for (;;) {
        auto end = text.find('\n', start);
        auto line = text.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (!line.empty() && line.back() == '\r' && end != std::string::npos) { line.pop_back(); }
        // checkPattern: not empty, not blank, no lone trailing backslash, not a comment.
        if (!line.empty() && !std::regex_search(line, blank) && !std::regex_search(line, trailing_backslash) && line[0] != '#') {
            Rule rule; auto body = line;
            if (body[0] == '!') { rule.negative = true; body = body.substr(1); }
            if (body.rfind("\\!", 0) == 0) { body = "!" + body.substr(2); }
            if (body.rfind("\\#", 0) == 0) { body = "#" + body.substr(2); }
            auto prefix = regex_prefix(body);
            // MODE_IGNORE trailing wildcard.
            static const auto trailing = re("(^|\\\\/)?\\\\\\*$");
            prefix = replace(prefix, trailing, false, [](const std::smatch &m, auto, auto &) { return (m[1].matched && !m[1].str().empty() ? m[1].str() + "[^/]+" : std::string("[^/]*")) + "(?=$|\\/$)"; });
            rule.source = prefix;
            state_->rules.push_back(std::move(rule));
            added = true;
        }
        if (end == std::string::npos) { break; }
        start = end + 1;
    }
    if (added) { state_->cache.clear(); }
}

// RuleManager.test with checkUnignored false; returns {ignored, unignored}.
static std::pair<bool, bool> test_rules(const std::vector<Rule> &rules, const std::string &path) {
    bool ignored = false, unignored = false;
    for (const auto &rule : rules) {
        if ((unignored == rule.negative && ignored != unignored) || (rule.negative && !ignored && !unignored)) { continue; }
        if (!rule.test(path)) { continue; }
        ignored = !rule.negative; unignored = rule.negative;
    }
    return {ignored, unignored};
}

bool Ignore::ignores(const std::string &path) const {
    static const auto invalid = re("^\\.{0,2}/|^\\.{1,2}$");
    if (path.empty()) { throw std::runtime_error("path must not be empty"); }
    if (std::regex_search(path, invalid)) { throw std::runtime_error("path should be a `path.relative()`d string, but got \"" + path + "\""); }
    // _t: a path is ignored when its nearest ignored parent folder is.
    std::function<std::pair<bool, bool>(const std::string &, std::vector<std::string>)> t = [&](const std::string &p, std::vector<std::string> slices) {
        if (const auto it = state_->cache.find(p); it != state_->cache.end()) { return it->second; }
        slices.pop_back();
        std::pair<bool, bool> result;
        if (slices.empty()) { result = test_rules(state_->rules, p); }
        else {
            std::string parent; for (const auto &s : slices) { parent += s + "/"; }
            const auto up = t(parent, slices);
            result = up.first ? up : test_rules(state_->rules, p);
        }
        return state_->cache[p] = result;
    };
    std::vector<std::string> slices; std::size_t start = 0;
    for (;;) { const auto e = path.find('/', start); const auto s = path.substr(start, e == std::string::npos ? std::string::npos : e - start); if (!s.empty()) { slices.push_back(s); } if (e == std::string::npos) { break; } start = e + 1; }
    return t(path, slices).first;
}

// stellan-host --gitignore-check: {"rules":["file text", …],"paths":[…]} on stdin; [true|false|"error", …] per path.
int check() {
    const std::string input((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
    const auto request = json::parse(input);
    Ignore ignore; std::string out = "[";
    try { for (const auto &r : request.find("rules")->array()) { ignore.add(r.string()); } }
    catch (const std::exception &error) { std::cout << "{\"error\":" << json::stringify_string(error.what()) << "}\n"; return 0; }
    bool first = true;
    for (const auto &p : request.find("paths")->array()) {
        if (!first) { out += ","; } first = false;
        try { out += ignore.ignores(p.string()) ? "true" : "false"; } catch (const std::exception &) { out += "\"error\""; }
    }
    std::cout << out << "]\n";
    return 0;
}
}
