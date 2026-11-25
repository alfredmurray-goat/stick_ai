#include "json.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <stdexcept>
#include <system_error>

namespace stellan::json {
const Value *Value::find(std::string_view key) const {
    if (!is_object()) { return nullptr; }
    for (const auto &[name, value] : object()) { if (name == key) { return &value; } }
    return nullptr;
}

namespace {
// Strings hold UTF-8; a lone UTF-16 surrogate from a \u escape is kept as its 3-byte (WTF-8) form so it can be
// written back exactly as JavaScript would (\udxxx).
void append_code_point(std::string &out, std::uint32_t c) {
    if (c < 0x80) { out += static_cast<char>(c); }
    else if (c < 0x800) { out += static_cast<char>(0xC0 | (c >> 6)); out += static_cast<char>(0x80 | (c & 0x3F)); }
    else if (c < 0x10000) { out += static_cast<char>(0xE0 | (c >> 12)); out += static_cast<char>(0x80 | ((c >> 6) & 0x3F)); out += static_cast<char>(0x80 | (c & 0x3F)); }
    else { out += static_cast<char>(0xF0 | (c >> 18)); out += static_cast<char>(0x80 | ((c >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((c >> 6) & 0x3F)); out += static_cast<char>(0x80 | (c & 0x3F)); }
}

struct Parser {
    std::string_view text;
    std::size_t at = 0;
    int depth = 0;
    [[noreturn]] void fail(const char *what) const { throw std::runtime_error(std::string(what) + " in JSON at position " + std::to_string(at)); }
    void space() { while (at < text.size() && (text[at] == ' ' || text[at] == '\t' || text[at] == '\n' || text[at] == '\r')) { ++at; } }
    bool take(char c) { if (at < text.size() && text[at] == c) { ++at; return true; } return false; }
    unsigned hex4() {
        if (at + 4 > text.size()) { fail("Bad Unicode escape"); }
        unsigned value = 0;
        for (int i = 0; i < 4; ++i) {
            const char c = text[at++];
            value <<= 4;
            if (c >= '0' && c <= '9') { value |= static_cast<unsigned>(c - '0'); }
            else if (c >= 'a' && c <= 'f') { value |= static_cast<unsigned>(c - 'a' + 10); }
            else if (c >= 'A' && c <= 'F') { value |= static_cast<unsigned>(c - 'A' + 10); }
            else { fail("Bad Unicode escape"); }
        }
        return value;
    }
    std::string string() {
        if (!take('"')) { fail("Expected string"); }
        std::string out;
        for (;;) {
            if (at >= text.size()) { fail("Unterminated string"); }
            const auto c = static_cast<unsigned char>(text[at]);
            if (c == '"') { ++at; return out; }
            if (c < 0x20) { fail("Bad control character in string literal"); }
            if (c != '\\') { out += static_cast<char>(c); ++at; continue; }
            ++at;
            if (at >= text.size()) { fail("Unterminated string"); }
            switch (text[at++]) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    std::uint32_t unit = hex4();
                    if (unit >= 0xD800 && unit <= 0xDBFF && at + 6 <= text.size() && text[at] == '\\' && text[at + 1] == 'u') {
                        const auto save = at; at += 2;
                        const auto low = hex4();
                        if (low >= 0xDC00 && low <= 0xDFFF) { unit = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00); }
                        else { at = save; }
                    }
                    append_code_point(out, unit);
                    break;
                }
                default: --at; fail("Bad escaped character");
            }
        }
    }
    double number() {
        const auto start = at;
        take('-');
        if (take('0')) {}
        else if (at < text.size() && text[at] >= '1' && text[at] <= '9') { while (at < text.size() && std::isdigit(static_cast<unsigned char>(text[at]))) { ++at; } }
        else { fail("No number after minus sign"); }
        if (take('.')) {
            if (at >= text.size() || !std::isdigit(static_cast<unsigned char>(text[at]))) { fail("Unterminated fractional number"); }
            while (at < text.size() && std::isdigit(static_cast<unsigned char>(text[at]))) { ++at; }
        }
        if (at < text.size() && (text[at] == 'e' || text[at] == 'E')) {
            ++at;
            if (!take('+')) { take('-'); }
            if (at >= text.size() || !std::isdigit(static_cast<unsigned char>(text[at]))) { fail("Exponent part is missing a number"); }
            while (at < text.size() && std::isdigit(static_cast<unsigned char>(text[at]))) { ++at; }
        }
        // strtod (not from_chars, which Apple's libc++ lacks for floating point) on the already-validated lexeme:
        // correctly rounded, and like JavaScript it rounds overflow to Infinity and underflow to 0. Host never
        // changes the C locale, so the decimal point is always '.'.
        const std::string lexeme(text.substr(start, at - start));
        return std::strtod(lexeme.c_str(), nullptr);
    }
    Value value() {
        space();
        if (at >= text.size()) { fail("Unexpected end of JSON input"); }
        const char c = text[at];
        if (c == '{' || c == '[') {
            // Bounded so deep input cannot overflow a 1 MB thread stack (JavaScript allows deeper; tool calls never need it).
            if (++depth > 1000) { fail("Too deeply nested"); }
        }
        Value result;
        if (c == '{') {
            ++at;
            auto object = std::make_shared<Object>();
            space();
            if (!take('}')) {
                for (;;) {
                    space();
                    auto key = string();
                    space();
                    if (!take(':')) { fail("Expected ':' after property name"); }
                    auto item = value();
                    bool replaced = false;
                    for (auto &[name, existing] : *object) { if (name == key) { existing = std::move(item); replaced = true; break; } }
                    if (!replaced) { object->emplace_back(std::move(key), std::move(item)); }
                    space();
                    if (take('}')) { break; }
                    if (!take(',')) { fail("Expected ',' or '}' after property value"); }
                }
            }
            result.data = std::move(object);
            --depth;
        } else if (c == '[') {
            ++at;
            auto array = std::make_shared<Array>();
            space();
            if (!take(']')) {
                for (;;) {
                    array->push_back(value());
                    space();
                    if (take(']')) { break; }
                    if (!take(',')) { fail("Expected ',' or ']' after array element"); }
                }
            }
            result.data = std::move(array);
            --depth;
        } else if (c == '"') { result.data = string(); }
        else if (c == '-' || (c >= '0' && c <= '9')) { result.data = number(); }
        else if (text.substr(at, 4) == "true") { at += 4; result.data = true; }
        else if (text.substr(at, 5) == "false") { at += 5; result.data = false; }
        else if (text.substr(at, 4) == "null") { at += 4; result.data = Null {}; }
        else { fail("Unexpected token"); }
        return result;
    }
};

// Number::toString from ECMAScript: shortest round-trip digits, fixed notation for exponents in [-7, 21).
std::string number_text(double value) {
    if (!std::isfinite(value)) { return "null"; }
    if (value == 0) { return "0"; }
    char buffer[64];
    const auto result = std::to_chars(buffer, buffer + sizeof buffer, value, std::chars_format::scientific);
    std::string scientific(buffer, result.ptr);
    std::string sign;
    if (scientific[0] == '-') { sign = "-"; scientific.erase(0, 1); }
    const auto e = scientific.find('e');
    std::string digits = scientific.substr(0, e);
    digits.erase(std::remove(digits.begin(), digits.end(), '.'), digits.end());
    while (digits.size() > 1 && digits.back() == '0') { digits.pop_back(); }
    const int exponent = std::stoi(scientific.substr(e + 1));
    const int k = static_cast<int>(digits.size()), n = exponent + 1;
    std::string out;
    if (k <= n && n <= 21) { out = digits + std::string(static_cast<std::size_t>(n - k), '0'); }
    else if (0 < n && n <= 21) { out = digits.substr(0, static_cast<std::size_t>(n)) + "." + digits.substr(static_cast<std::size_t>(n)); }
    else if (-6 < n && n <= 0) { out = "0." + std::string(static_cast<std::size_t>(-n), '0') + digits; }
    else {
        const int shown = n - 1;
        out = digits.substr(0, 1) + (k > 1 ? "." + digits.substr(1) : "") + "e" + (shown >= 0 ? "+" : "-") + std::to_string(std::abs(shown));
    }
    return sign + out;
}

void write(std::string &out, const Value &value) {
    if (value.is_null()) { out += "null"; }
    else if (const auto *b = std::get_if<bool>(&value.data)) { out += *b ? "true" : "false"; }
    else if (const auto *d = std::get_if<double>(&value.data)) { out += number_text(*d); }
    else if (value.is_string()) { out += stringify_string(value.string()); }
    else if (value.is_array()) {
        out += '[';
        bool first = true;
        for (const auto &item : value.array()) { if (!first) { out += ','; } first = false; write(out, item); }
        out += ']';
    } else {
        out += '{';
        bool first = true;
        for (const auto &[key, item] : value.object()) { if (!first) { out += ','; } first = false; out += stringify_string(key); out += ':'; write(out, item); }
        out += '}';
    }
}
}

Value parse(std::string_view text) {
    Parser parser {text};
    auto result = parser.value();
    parser.space();
    if (parser.at != text.size()) { parser.fail("Unexpected non-whitespace character after JSON"); }
    return result;
}

std::string stringify_string(std::string_view s) {
    static const char hex[] = "0123456789abcdef";
    std::string out = "\"";
    for (std::size_t i = 0; i < s.size(); ++i) {
        const auto c = static_cast<unsigned char>(s[i]);
        switch (c) {
            case '"': out += "\\\""; continue;
            case '\\': out += "\\\\"; continue;
            case '\b': out += "\\b"; continue;
            case '\f': out += "\\f"; continue;
            case '\n': out += "\\n"; continue;
            case '\r': out += "\\r"; continue;
            case '\t': out += "\\t"; continue;
            default: break;
        }
        if (c < 0x20) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; continue; }
        // Lone surrogates (kept as 3-byte WTF-8 by parse) are written back as escapes, like well-formed JSON.stringify.
        if (c == 0xED && i + 2 < s.size() && (static_cast<unsigned char>(s[i + 1]) & 0xE0) == 0xA0) {
            const unsigned unit = 0xD000u | ((static_cast<unsigned char>(s[i + 1]) & 0x3Fu) << 6) | (static_cast<unsigned char>(s[i + 2]) & 0x3Fu);
            out += "\\u"; out += hex[(unit >> 12) & 15]; out += hex[(unit >> 8) & 15]; out += hex[(unit >> 4) & 15]; out += hex[unit & 15];
            i += 2; continue;
        }
        out += static_cast<char>(c);
    }
    return out + "\"";
}

std::string stringify(const Value &value) { std::string out; write(out, value); return out; }
}
