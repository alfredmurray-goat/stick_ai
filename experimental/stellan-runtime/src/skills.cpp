#include "skills.hpp"

#include "agent_core.hpp"
#include "json.hpp"

#include <cmath>
#include <iostream>
#include <iterator>
#include <optional>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

// parseSkill from src/portable/skills.ts, with the SKILL.md frontmatter read by a small YAML reader instead of the
// `yaml` package. It covers what skill headers use (block mappings; plain, quoted and block scalars; flow and block
// collections; comments; YAML 1.2 core types) and refuses anything else with the app's usual frontmatter message,
// as it refuses aliases and repeated keys.
namespace stellan::skills {
namespace {
using json::Value;
struct SkillError : std::runtime_error { using std::runtime_error::runtime_error; };
[[noreturn]] void invalid() { throw SkillError("Invalid SKILL.md frontmatter. Use plain YAML without aliases."); }

// A frontmatter value: only strings and booleans are read by parseSkill; everything else just has to be valid.
struct Scalar { enum class Kind { string, boolean, other } kind = Kind::other; std::string text; bool flag = false; };

std::string trim_spaces(std::string_view s) {
    const auto a = s.find_first_not_of(" \t"); if (a == std::string_view::npos) { return {}; }
    const auto b = s.find_last_not_of(" \t"); return std::string(s.substr(a, b - a + 1));
}
std::size_t indent_of(std::string_view line) { std::size_t n = 0; while (n < line.size() && line[n] == ' ') { ++n; } return n; }
bool blank_or_comment(std::string_view line) { const auto t = trim_spaces(line); return t.empty() || t[0] == '#'; }

// YAML 1.2 core schema resolution of a plain scalar.
Scalar resolve(const std::string &plain) {
    static const std::regex number(R"(^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$|^0x[0-9a-fA-F]+$|^0o[0-7]+$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$)");
    if (plain.empty() || plain == "~" || plain == "null" || plain == "Null" || plain == "NULL") { return {}; }
    if (plain == "true" || plain == "True" || plain == "TRUE") { return {Scalar::Kind::boolean, plain, true}; }
    if (plain == "false" || plain == "False" || plain == "FALSE") { return {Scalar::Kind::boolean, plain, false}; }
    if (std::regex_match(plain, number)) { return {}; }
    return {Scalar::Kind::string, plain, false};
}

// Strips a trailing " #comment" from a plain scalar line and checks the characters YAML does not allow there.
std::string plain_part(std::string_view text) {
    std::string out(text);
    for (std::size_t i = 0; i < out.size(); ++i) {
        if (out[i] == '#' && (i == 0 || out[i - 1] == ' ' || out[i - 1] == '\t')) { out.resize(i); break; }
        // ": " (or a final ':') inside a plain value would start a nested mapping, which YAML refuses here.
        if (out[i] == ':' && (i + 1 == out.size() || out[i + 1] == ' ' || out[i + 1] == '\t')) { invalid(); }
    }
    return trim_spaces(out);
}

class Reader {
public:
    explicit Reader(std::string_view text) {
        std::size_t start = 0;
        for (;;) {
            const auto end = text.find('\n', start);
            auto line = std::string(text.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start));
            if (!line.empty() && line.back() == '\r') { line.pop_back(); }
            if (line.find('\t') != std::string::npos && line.find_first_not_of('\t') != std::string::npos && line.find_first_not_of(" \t") > line.find('\t')) { invalid(); } // tab indentation
            lines_.push_back(line);
            if (end == std::string_view::npos) { break; }
            start = end + 1;
        }
    }
    // The top-level block mapping: key -> scalar.
    std::vector<std::pair<std::string, Scalar>> mapping() {
        std::vector<std::pair<std::string, Scalar>> out; std::set<std::string> keys;
        std::size_t i = 0;
        // Document markers are not used by skill headers; a bare scalar or sequence is not a mapping either.
        while (i < lines_.size()) {
            if (blank_or_comment(lines_[i])) { ++i; continue; }
            if (indent_of(lines_[i]) != 0) { invalid(); }
            const auto &line = lines_[i];
            if (line.rfind("- ", 0) == 0 || line == "-" || line.rfind("---", 0) == 0 || line.rfind("...", 0) == 0 || line[0] == '%') { invalid(); }
            const auto [key, rest] = split_key(line);
            if (!keys.insert(key).second) { invalid(); }
            ++i;
            out.emplace_back(key, value(rest, 0, i));
        }
        return out;
    }
private:
    std::vector<std::string> lines_;
    std::pair<std::string, std::string> split_key(const std::string &line) {
        std::string key; std::size_t at = 0;
        if (line[0] == '"' || line[0] == '\'') {
            const auto q = line[0]; at = 1;
            while (at < line.size() && line[at] != q) { if (q == '"' && line[at] == '\\') { ++at; } key += line[at++]; }
            if (at >= line.size()) { invalid(); }
            ++at;
            if (at >= line.size() || line[at] != ':') { invalid(); }
        } else {
            while (at < line.size() && !(line[at] == ':' && (at + 1 == line.size() || line[at + 1] == ' ' || line[at + 1] == '\t'))) { ++at; }
            if (at >= line.size()) { invalid(); }
            key = trim_spaces(std::string_view(line).substr(0, at));
            if (key.empty() || key[0] == '[' || key[0] == '{' || key[0] == '&' || key[0] == '*' || key[0] == '!' || key[0] == '?' || key[0] == '#') { invalid(); }
        }
        return {key, line.substr(at + 1)};
    }
    // Lines after the key that belong to its value: more indented than `parent`, or blank.
    std::size_t block_end(std::size_t from, std::size_t parent) {
        auto end = from;
        while (end < lines_.size() && (trim_spaces(lines_[end]).empty() || indent_of(lines_[end]) > parent)) { ++end; }
        while (end > from && trim_spaces(lines_[end - 1]).empty()) { --end; }
        return end;
    }
    Scalar value(const std::string &raw, std::size_t parent, std::size_t &next) {
        auto rest = trim_spaces(raw);
        if (!rest.empty() && rest[0] == '*') { invalid(); } // alias
        if (!rest.empty() && rest[0] == '&') { const auto space = rest.find(' '); rest = space == std::string::npos ? "" : trim_spaces(std::string_view(rest).substr(space)); } // anchor
        if (!rest.empty() && rest[0] == '!') { invalid(); } // tags
        if (rest.empty() || rest[0] == '#') {
            // A nested block (mapping or sequence) or nothing at all: either way not a string.
            const auto end = block_end(next, parent);
            for (auto k = next; k < end; ++k) { const auto t = trim_spaces(lines_[k]); if (!t.empty() && (t[0] == '*' || t.find(" *") != std::string::npos || t.find(": *") != std::string::npos)) { invalid(); } }
            next = end;
            return {};
        }
        if (rest[0] == '|' || rest[0] == '>') { return block_scalar(rest, parent, next); }
        if (rest[0] == '"') { return Scalar {Scalar::Kind::string, double_quoted(rest, parent, next), false}; }
        if (rest[0] == '\'') { return Scalar {Scalar::Kind::string, single_quoted(rest, parent, next), false}; }
        if (rest[0] == '[' || rest[0] == '{') { flow(rest, parent, next); return {}; }
        if (rest[0] == '@' || rest[0] == '`' || rest[0] == '%' || ((rest[0] == '-' || rest[0] == '?') && rest.size() > 1 && rest[1] == ' ')) { invalid(); }
        // A plain scalar may continue on more-indented lines, folded with single spaces.
        auto text = plain_part(rest);
        const auto end = block_end(next, parent);
        for (auto k = next; k < end; ++k) {
            const auto t = trim_spaces(lines_[k]);
            if (t.empty()) { text += '\n'; continue; }
            if (t[0] == '#') { invalid(); }
            const auto part = plain_part(t);
            if (!text.empty() && text.back() != '\n') { text += ' '; }
            text += part;
        }
        next = end;
        return resolve(text);
    }
    Scalar block_scalar(const std::string &header, std::size_t parent, std::size_t &next) {
        const bool literal = header[0] == '|';
        char chomp = 'c'; std::size_t explicit_indent = 0;
        for (std::size_t k = 1; k < header.size(); ++k) {
            const char c = header[k];
            if (c == '-' || c == '+') { chomp = c; }
            else if (c >= '1' && c <= '9') { explicit_indent = static_cast<std::size_t>(c - '0'); }
            else if (c == ' ' || c == '\t') { const auto t = trim_spaces(std::string_view(header).substr(k)); if (!t.empty() && t[0] != '#') { invalid(); } break; }
            else { invalid(); }
        }
        auto end = next;
        while (end < lines_.size() && (trim_spaces(lines_[end]).empty() || indent_of(lines_[end]) > parent)) { ++end; }
        std::size_t indent = explicit_indent ? parent + explicit_indent : 0;
        for (auto k = next; k < end && !indent; ++k) { if (!trim_spaces(lines_[k]).empty()) { indent = indent_of(lines_[k]); } }
        std::vector<std::string> content;
        for (auto k = next; k < end; ++k) { content.push_back(lines_[k].size() >= indent ? lines_[k].substr(indent) : std::string()); }
        next = end;
        // Trailing blank lines only matter for "keep" chomping.
        std::size_t last = content.size();
        while (last > 0 && trim_spaces(content[last - 1]).empty()) { --last; }
        std::string text;
        for (std::size_t k = 0; k < last; ++k) {
            const auto &line = content[k];
            if (literal) { text += line; text += '\n'; continue; }
            // Folding: lines join with a space; blank lines become newlines; more-indented lines keep their breaks.
            const bool more = !line.empty() && (line[0] == ' ' || line[0] == '\t');
            if (k > 0) {
                const auto &previous = content[k - 1];
                const bool previous_more = !previous.empty() && (previous[0] == ' ' || previous[0] == '\t');
                if (line.empty()) { text += '\n'; continue; }
                if (previous.empty() || more || previous_more) { if (!previous.empty()) { text += '\n'; } }
                else { text += ' '; }
            }
            text += line;
        }
        if (!literal && last > 0) { text += '\n'; }
        if (chomp == '-') { while (!text.empty() && text.back() == '\n') { text.pop_back(); } }
        else if (chomp == '+') { for (auto k = last; k < content.size(); ++k) { text += '\n'; } }
        if (last == 0 && chomp != '+') { text.clear(); }
        return {Scalar::Kind::string, text, false};
    }
    // Quoted scalars may span lines; line breaks fold to a space, blank lines to newlines.
    std::string gather(const std::string &first, char quote, std::size_t &next) {
        std::string all = first;
        auto closed = [&](const std::string &s) {
            for (std::size_t k = 1; k < s.size(); ++k) {
                if (quote == '"' && s[k] == '\\') { ++k; continue; }
                if (s[k] == quote) { if (quote == '\'' && k + 1 < s.size() && s[k + 1] == '\'') { ++k; continue; } return k; }
            }
            return std::string::npos;
        };
        while (closed(all) == std::string::npos) {
            if (next >= lines_.size()) { invalid(); }
            all += '\n'; all += lines_[next++];
        }
        const auto end = closed(all);
        const auto after = trim_spaces(std::string_view(all).substr(end + 1));
        if (!after.empty() && after[0] != '#') { invalid(); }
        std::string inner = all.substr(1, end - 1), folded;
        // Fold the line breaks inside the quotes.
        std::vector<std::string> parts; std::size_t s = 0;
        for (;;) { const auto e = inner.find('\n', s); parts.push_back(inner.substr(s, e == std::string::npos ? std::string::npos : e - s)); if (e == std::string::npos) { break; } s = e + 1; }
        for (std::size_t k = 0; k < parts.size(); ++k) {
            auto piece = parts[k];
            if (k > 0) { const auto a = piece.find_first_not_of(" \t"); piece = a == std::string::npos ? "" : piece.substr(a); }
            if (k + 1 < parts.size()) { const auto b = piece.find_last_not_of(" \t"); piece = b == std::string::npos ? "" : piece.substr(0, b + 1); }
            if (k > 0) { folded += piece.empty() && k + 1 < parts.size() ? "\n" : (folded.empty() || folded.back() == '\n' ? "" : " "); }
            folded += piece;
        }
        return folded;
    }
    std::string single_quoted(const std::string &rest, std::size_t, std::size_t &next) {
        const auto raw = gather(rest, '\'', next);
        std::string out; for (std::size_t k = 0; k < raw.size(); ++k) { out += raw[k]; if (raw[k] == '\'' && k + 1 < raw.size() && raw[k + 1] == '\'') { ++k; } }
        return out;
    }
    static void utf8(std::string &out, std::uint32_t c) {
        if (c < 0x80) { out += static_cast<char>(c); }
        else if (c < 0x800) { out += static_cast<char>(0xC0 | (c >> 6)); out += static_cast<char>(0x80 | (c & 63)); }
        else if (c < 0x10000) { out += static_cast<char>(0xE0 | (c >> 12)); out += static_cast<char>(0x80 | ((c >> 6) & 63)); out += static_cast<char>(0x80 | (c & 63)); }
        else { out += static_cast<char>(0xF0 | (c >> 18)); out += static_cast<char>(0x80 | ((c >> 12) & 63)); out += static_cast<char>(0x80 | ((c >> 6) & 63)); out += static_cast<char>(0x80 | (c & 63)); }
    }
    std::string double_quoted(const std::string &rest, std::size_t, std::size_t &next) {
        const auto raw = gather(rest, '"', next);
        std::string out;
        for (std::size_t k = 0; k < raw.size(); ++k) {
            if (raw[k] != '\\') { out += raw[k]; continue; }
            if (++k >= raw.size()) { invalid(); }
            const char e = raw[k];
            const auto hex = [&](std::size_t n) {
                if (k + n >= raw.size() + 0 && k + n > raw.size() - 1 + 1) { invalid(); }
                std::uint32_t v = 0;
                for (std::size_t d = 1; d <= n; ++d) { if (k + d >= raw.size() || !std::isxdigit(static_cast<unsigned char>(raw[k + d]))) { invalid(); } v = v * 16 + static_cast<std::uint32_t>(std::stoi(std::string(1, raw[k + d]), nullptr, 16)); }
                k += n; return v;
            };
            switch (e) {
                case '0': out += '\0'; break; case 'a': out += '\a'; break; case 'b': out += '\b'; break; case 't': case '\t': out += '\t'; break;
                case 'n': out += '\n'; break; case 'v': out += '\v'; break; case 'f': out += '\f'; break; case 'r': out += '\r'; break;
                case 'e': out += '\x1b'; break; case ' ': out += ' '; break; case '"': out += '"'; break; case '/': out += '/'; break; case '\\': out += '\\'; break;
                case 'N': utf8(out, 0x85); break; case '_': utf8(out, 0xA0); break; case 'L': utf8(out, 0x2028); break; case 'P': utf8(out, 0x2029); break;
                case 'x': utf8(out, hex(2)); break; case 'u': utf8(out, hex(4)); break; case 'U': utf8(out, hex(8)); break;
                default: invalid();
            }
        }
        return out;
    }
    // Flow collections: balanced brackets with quoted strings, possibly over several lines; aliases are refused.
    void flow(const std::string &rest, std::size_t, std::size_t &next) {
        std::string all = rest; int depth = 0; bool done = false;
        for (;;) {
            char quote = 0;
            for (std::size_t k = 0; k < all.size(); ++k) {
                const char c = all[k];
                if (quote) { if (c == '\\' && quote == '"') { ++k; } else if (c == quote) { quote = 0; } continue; }
                if (c == '"' || c == '\'') { quote = c; continue; }
                if (c == '*') { invalid(); }
                if (c == '#' && (k == 0 || all[k - 1] == ' ')) { while (k < all.size() && all[k] != '\n') { ++k; } continue; }
                if (c == '[' || c == '{') { ++depth; }
                if (c == ']' || c == '}') { if (--depth == 0) { const auto after = trim_spaces(std::string_view(all).substr(k + 1)); if (!after.empty() && after[0] != '#' && after.find('\n') == std::string::npos) { invalid(); } done = true; break; } }
            }
            if (done) { return; }
            if (next >= lines_.size()) { invalid(); }
            all += '\n'; all += lines_[next++]; depth = 0;
        }
    }
};

bool slug(const std::string &name) {
    if (name.empty() || name.size() > 64) { return false; }
    if (!((name[0] >= 'a' && name[0] <= 'z') || (name[0] >= '0' && name[0] <= '9'))) { return false; }
    for (const char c : name) { if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) { return false; } }
    return true;
}
// JavaScript's /\s+/g replacement with one space (Unicode spaces included), as parseSkill normalises descriptions.
std::string collapse_spaces(const std::string &s) {
    std::string out; bool space = false;
    for (std::size_t i = 0; i < s.size();) {
        const auto c = static_cast<unsigned char>(s[i]);
        std::size_t n = 1; bool ws = c == ' ' || (c >= 9 && c <= 13);
        if (c == 0xC2 && i + 1 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0xA0) { ws = true; n = 2; }
        else if (c == 0xE2 && i + 2 < s.size()) {
            const auto b = static_cast<unsigned char>(s[i + 1]), d = static_cast<unsigned char>(s[i + 2]);
            if ((b == 0x80 && (d <= 0x8A || d == 0xA8 || d == 0xA9 || d == 0xAF)) || (b == 0x81 && d == 0x9F)) { ws = true; n = 3; }
        } else if (c == 0xE3 && i + 2 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0x80 && static_cast<unsigned char>(s[i + 2]) == 0x80) { ws = true; n = 3; }
        else if (c == 0xEF && i + 2 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0xBB && static_cast<unsigned char>(s[i + 2]) == 0xBF) { ws = true; n = 3; }
        else if (c == 0xE1 && i + 2 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0x9A && static_cast<unsigned char>(s[i + 2]) == 0x80) { ws = true; n = 3; }
        if (ws) { if (!space) { out += ' '; } space = true; }
        else { out.append(s, i, n); space = false; }
        i += n;
    }
    return out;
}
std::size_t utf16_length(const std::string &s) { std::size_t n = 0; for (const unsigned char c : s) { if ((c & 0xC0) != 0x80) { n += c >= 0xF0 ? 2 : 1; } } return n; }
}

Parsed parse(std::string text, const std::string &fallback) {
    if (text.size() > 65536) { throw SkillError("SKILL.md must be under 64 KiB."); }
    if (text.rfind("\xEF\xBB\xBF", 0) == 0) { text.erase(0, 3); }
    std::vector<std::pair<std::string, Scalar>> meta;
    std::string body = text;
    // ^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)
    if (text.rfind("---\n", 0) == 0 || text.rfind("---\r\n", 0) == 0) {
        const std::size_t start = text[3] == '\r' ? 5 : 4;
        // The earliest "\n---" after the opening line that ends the line or the file.
        for (auto at = text.find("\n---", start); at != std::string::npos; at = text.find("\n---", at + 1)) {
            const auto after = at + 4;
            std::size_t match_end;
            if (after == text.size()) { match_end = after; }
            else if (text[after] == '\n') { match_end = after + 1; }
            else if (text[after] == '\r' && after + 1 < text.size() && text[after + 1] == '\n') { match_end = after + 2; }
            else { continue; }
            auto front_end = at;
            if (front_end > start && text[front_end - 1] == '\r') { --front_end; }
            const auto front = text.substr(start, front_end - start);
            try { meta = Reader(front).mapping(); }
            catch (const SkillError &) { throw; }
            catch (const std::exception &) { invalid(); }
            if (meta.empty()) { invalid(); } // an empty or comment-only header is not a mapping
            body = text.substr(match_end);
            break;
        }
    }
    const auto get = [&](const std::string &key) -> const Scalar * { for (const auto &[k, v] : meta) { if (k == key) { return &v; } } return nullptr; };
    const auto *name_value = get("name");
    const auto name = name_value && name_value->kind == Scalar::Kind::string ? name_value->text : fallback;
    if (!slug(name)) { throw SkillError("Skill names use lowercase letters, numbers and hyphens (up to 64 characters)."); }
    std::string description;
    if (const auto *d = get("description"); d && d->kind == Scalar::Kind::string) { description = agent::js_trim(collapse_spaces(d->text)); }
    else {
        bool found = false; std::size_t start = 0;
        while (start <= body.size()) {
            const auto end = body.find('\n', start);
            auto line = body.substr(start, end == std::string::npos ? std::string::npos : end - start);
            if (!line.empty() && line.back() == '\r') { line.pop_back(); }
            if (!agent::js_trim(line).empty()) { std::size_t h = 0; while (h < line.size() && line[h] == '#') { ++h; } if (h > 0) { while (h < line.size() && (line[h] == ' ' || line[h] == '\t')) { ++h; } line = line.substr(h); } description = line; found = true; break; }
            if (end == std::string::npos) { break; }
            start = end + 1;
        }
        if (!found) { description = name; }
    }
    if (description.empty() || utf16_length(description) > 1000 || agent::js_trim(body).empty()) { throw SkillError("Add a description and Markdown instructions."); }
    const auto *model = get("disable-model-invocation"), *user = get("user-invocable");
    return {name, description, agent::js_trim(body), !(model && model->kind == Scalar::Kind::boolean && model->flag), !(user && user->kind == Scalar::Kind::boolean && !user->flag)};
}

// stellan-host --parse-skill FALLBACK: SKILL.md text on stdin; the parsed skill or {"error":...} on stdout.
int parse_skill(int argc, char **argv) {
    const std::string fallback = argc > 2 ? argv[2] : "";
    const std::string text((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
    try {
        const auto s = parse(text, fallback);
        std::cout << "{\"name\":" << json::stringify_string(s.name) << ",\"description\":" << json::stringify_string(s.description) << ",\"body\":" << json::stringify_string(s.body)
                  << ",\"modelInvocable\":" << (s.model_invocable ? "true" : "false") << ",\"userInvocable\":" << (s.user_invocable ? "true" : "false") << "}\n";
    } catch (const std::exception &error) { std::cout << "{\"error\":" << json::stringify_string(error.what()) << "}\n"; }
    return 0;
}
}
