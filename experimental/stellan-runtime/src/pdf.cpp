#include "documents.hpp"

#include "agent_core.hpp"
#include "inflate.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

// Stellan's own PDF text reader: text only, nothing is executed, fetched or rendered. Objects are found by scanning
// the file (damaged cross-reference tables are common), compressed object streams are unpacked, pages are walked in
// order, and each page's text operators are followed with the fonts' ToUnicode maps or their standard encodings.
// Output, limits and messages follow portable/input-worker.mjs.
namespace stellan::documents {
namespace {
constexpr std::size_t max_text_bytes = 24000;
[[noreturn]] void fail(const std::string &message) { throw std::runtime_error(message); }
[[noreturn]] void broken() { fail("This PDF could not be read. Save it again as a PDF and try once more."); }

// --- Objects ------------------------------------------------------------------------------------------------------
struct Object;
using Array = std::vector<Object>;
using Dict = std::map<std::string, Object>;
struct Ref { int number = 0, generation = 0; bool operator<(const Ref &o) const { return number < o.number || (number == o.number && generation < o.generation); } };
struct Name { std::string value; };
struct Operator { std::string value; };
struct Object {
    std::variant<std::monostate, bool, double, std::string, Name, std::shared_ptr<Array>, std::shared_ptr<Dict>, Ref, Operator> v;
    std::string stream; bool has_stream = false;
    const Dict *dict() const { const auto *d = std::get_if<std::shared_ptr<Dict>>(&v); return d ? d->get() : nullptr; }
    const Array *array() const { const auto *a = std::get_if<std::shared_ptr<Array>>(&v); return a ? a->get() : nullptr; }
    const std::string *name() const { const auto *n = std::get_if<Name>(&v); return n ? &n->value : nullptr; }
    const std::string *string() const { return std::get_if<std::string>(&v); }
    std::optional<double> number() const { if (const auto *d = std::get_if<double>(&v)) { return *d; } return std::nullopt; }
    const Ref *ref() const { return std::get_if<Ref>(&v); }
    const std::string *op() const { const auto *o = std::get_if<Operator>(&v); return o ? &o->value : nullptr; }
};
const Object *find(const Dict *d, const std::string &key) { if (!d) { return nullptr; } const auto it = d->find(key); return it == d->end() ? nullptr : &it->second; }

bool white(char c) { return c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '\f' || c == '\0'; }
bool delimiter(char c) { return c == '(' || c == ')' || c == '<' || c == '>' || c == '[' || c == ']' || c == '{' || c == '}' || c == '/' || c == '%'; }

class Lexer {
public:
    Lexer(std::string_view data, std::size_t at = 0) : d_(data), at_(at) {}
    std::size_t at() const { return at_; }
    void skip() {
        while (at_ < d_.size()) {
            if (white(d_[at_])) { ++at_; continue; }
            if (d_[at_] == '%') { while (at_ < d_.size() && d_[at_] != '\n' && d_[at_] != '\r') { ++at_; } continue; }
            break;
        }
    }
    bool done() { skip(); return at_ >= d_.size(); }
    // One object; in content streams, bare words come back as operators.
    Object next(int depth = 0) {
        if (depth > 64) { broken(); }
        skip();
        if (at_ >= d_.size()) { broken(); }
        const char c = d_[at_];
        if (c == '/') { ++at_; return Object {Name {word(true)}}; }
        if (c == '(') { return Object {literal()}; }
        if (c == '<' && at_ + 1 < d_.size() && d_[at_ + 1] == '<') {
            at_ += 2; auto dict = std::make_shared<Dict>();
            for (;;) {
                skip();
                if (at_ + 1 < d_.size() && d_[at_] == '>' && d_[at_ + 1] == '>') { at_ += 2; break; }
                const auto key = next(depth + 1);
                if (!key.name()) { broken(); }
                (*dict)[*key.name()] = next(depth + 1);
            }
            return Object {dict};
        }
        if (c == '<') { return Object {hex()}; }
        if (c == '[') {
            ++at_; auto array = std::make_shared<Array>();
            for (;;) { skip(); if (at_ < d_.size() && d_[at_] == ']') { ++at_; break; } array->push_back(next(depth + 1)); if (array->size() > 1000000) { broken(); } }
            return Object {array};
        }
        if (c == ']' || c == '>' || c == ')' || c == '{' || c == '}') { ++at_; return Object {Operator {std::string(1, c)}}; }
        if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.') {
            const auto start = at_;
            const auto first = number();
            // "N G R": an indirect reference.
            const auto save = at_;
            skip();
            if (first && std::floor(*first) == *first && at_ < d_.size() && d_[at_] >= '0' && d_[at_] <= '9') {
                const auto second = number(); skip();
                if (second && at_ < d_.size() && d_[at_] == 'R' && (at_ + 1 >= d_.size() || white(d_[at_ + 1]) || delimiter(d_[at_ + 1]))) { ++at_; return Object {Ref {static_cast<int>(*first), static_cast<int>(*second)}}; }
            }
            at_ = save;
            if (!first) { at_ = start + 1; return Object {Operator {std::string(1, c)}}; }
            return Object {*first};
        }
        const auto w = word(false);
        if (w == "true") { return Object {true}; }
        if (w == "false") { return Object {false}; }
        if (w == "null") { return Object {}; }
        return Object {Operator {w}};
    }
private:
    std::string_view d_; std::size_t at_;
    std::optional<double> number() {
        const auto start = at_;
        if (at_ < d_.size() && (d_[at_] == '-' || d_[at_] == '+')) { ++at_; }
        bool digits = false;
        while (at_ < d_.size() && ((d_[at_] >= '0' && d_[at_] <= '9') || d_[at_] == '.')) { digits = digits || d_[at_] != '.'; ++at_; }
        if (!digits) { at_ = start; return std::nullopt; }
        try { return std::stod(std::string(d_.substr(start, at_ - start))); } catch (...) { return 0.0; }
    }
    std::string word(bool name) {
        std::string out;
        while (at_ < d_.size() && !white(d_[at_]) && !delimiter(d_[at_])) {
            if (name && d_[at_] == '#' && at_ + 2 < d_.size() && std::isxdigit(static_cast<unsigned char>(d_[at_ + 1])) && std::isxdigit(static_cast<unsigned char>(d_[at_ + 2]))) {
                out += static_cast<char>(std::stoi(std::string(d_.substr(at_ + 1, 2)), nullptr, 16)); at_ += 3; continue;
            }
            out += d_[at_++];
        }
        if (out.empty() && !name) { out = std::string(1, d_[at_++]); }
        return out;
    }
    std::string literal() {
        ++at_; std::string out; int depth = 1;
        while (at_ < d_.size()) {
            const char c = d_[at_++];
            if (c == '\\' && at_ < d_.size()) {
                const char e = d_[at_++];
                switch (e) {
                    case 'n': out += '\n'; break; case 'r': out += '\r'; break; case 't': out += '\t'; break;
                    case 'b': out += '\b'; break; case 'f': out += '\f'; break;
                    case '\r': if (at_ < d_.size() && d_[at_] == '\n') { ++at_; } break;
                    case '\n': break;
                    default:
                        if (e >= '0' && e <= '7') {
                            int value = e - '0';
                            for (int k = 0; k < 2 && at_ < d_.size() && d_[at_] >= '0' && d_[at_] <= '7'; ++k) { value = value * 8 + (d_[at_++] - '0'); }
                            out += static_cast<char>(value & 0xFF);
                        } else { out += e; }
                }
                continue;
            }
            if (c == '(') { ++depth; } else if (c == ')' && --depth == 0) { break; }
            out += c;
        }
        return out;
    }
    std::string hex() {
        ++at_; std::string digits;
        while (at_ < d_.size() && d_[at_] != '>') { if (std::isxdigit(static_cast<unsigned char>(d_[at_]))) { digits += d_[at_]; } ++at_; }
        ++at_;
        if (digits.size() % 2) { digits += '0'; }
        std::string out;
        for (std::size_t i = 0; i < digits.size(); i += 2) { out += static_cast<char>(std::stoi(digits.substr(i, 2), nullptr, 16)); }
        return out;
    }
};

// --- The document -------------------------------------------------------------------------------------------------
class Document {
public:
    explicit Document(std::string_view data) : data_(data) {
        // Every "N G obj" in the file; later definitions replace earlier ones, as incremental updates do.
        for (std::size_t at = data_.find(" obj"); at != std::string_view::npos; at = data_.find(" obj", at + 4)) {
            if (at + 4 < data_.size() && !white(data_[at + 4]) && !delimiter(data_[at + 4])) { continue; }
            auto start = at;
            const auto back = [&] { while (start > 0 && white(data_[start - 1])) { --start; } };
            back(); auto g_end = start; while (start > 0 && std::isdigit(static_cast<unsigned char>(data_[start - 1]))) { --start; }
            if (start == g_end) { continue; }
            const auto generation = std::atoi(std::string(data_.substr(start, g_end - start)).c_str());
            back(); auto n_end = start; while (start > 0 && std::isdigit(static_cast<unsigned char>(data_[start - 1]))) { --start; }
            if (start == n_end || (start > 0 && !white(data_[start - 1]) && !delimiter(data_[start - 1]))) { continue; }
            const auto number = std::atoi(std::string(data_.substr(start, n_end - start)).c_str());
            offsets_[Ref {number, generation}] = at + 4;
            if (offsets_.size() > 2000000) { broken(); }
        }
        if (data_.find("/Encrypt") != std::string_view::npos && trailer_has("/Encrypt")) { fail("Unlock the password-protected PDF before attaching it."); }
        // Objects packed inside compressed object streams (PDF 1.5 and later).
        for (const auto &[ref, offset] : std::map<Ref, std::size_t>(offsets_)) {
            const auto object = load(ref);
            const auto *type = find(object.dict(), "Type");
            if (!type || !type->name() || *type->name() != "ObjStm" || !object.has_stream) { continue; }
            try {
                const auto body = decoded(object);
                const auto n = find(object.dict(), "N"), first = find(object.dict(), "First");
                if (!n || !first || !n->number() || !first->number()) { continue; }
                Lexer header(body);
                for (int i = 0; i < static_cast<int>(*n->number()) && i < 100000; ++i) {
                    const auto number = header.next(), offset_in = header.next();
                    if (!number.number() || !offset_in.number()) { break; }
                    const auto where = static_cast<std::size_t>(*first->number() + *offset_in.number());
                    if (where >= body.size()) { break; }
                    const Ref packed {static_cast<int>(*number.number()), 0};
                    if (offsets_.count(packed)) { continue; }
                    Lexer reader(body, where);
                    packed_[packed] = reader.next();
                }
            } catch (const std::exception &) {}
        }
    }
    Object resolve(const Object &object, int depth = 0) {
        const auto *r = object.ref();
        if (!r) { return object; }
        if (depth > 32) { broken(); }
        return resolve(get(*r), depth + 1);
    }
    Object get(const Ref &ref) {
        if (const auto it = cache_.find(ref); it != cache_.end()) { return it->second; }
        Object result;
        if (offsets_.count(ref)) { result = load(ref); }
        else if (const auto it = packed_.find(ref); it != packed_.end()) { result = it->second; }
        cache_[ref] = result;
        return result;
    }
    std::string decoded(const Object &object) {
        auto data = object.stream;
        const auto *filter = find(object.dict(), "Filter");
        std::vector<std::string> filters;
        if (filter) {
            const auto f = resolve(*filter);
            if (f.name()) { filters.push_back(*f.name()); }
            if (const auto *list = f.array()) { for (const auto &item : *list) { if (item.name()) { filters.push_back(*item.name()); } } }
        }
        for (const auto &name : filters) {
            if (name == "FlateDecode" || name == "Fl") { data = inflate_zlib(data); continue; }
            if (name == "ASCII85Decode" || name == "A85") { data = ascii85(data); continue; }
            if (name == "ASCIIHexDecode" || name == "AHx") { data = ascii_hex(data); continue; }
            if (name == "LZWDecode" || name == "LZW") { data = lzw(data); continue; }
            return {}; // images and other encodings carry no text
        }
        return data;
    }
    std::vector<Object> pages() {
        std::vector<Object> result;
        Object root;
        for (const auto &[ref, offset] : offsets_) {
            (void)offset;
            const auto object = get(ref);
            const auto *type = find(object.dict(), "Type");
            if (type && type->name() && *type->name() == "Catalog") { root = object; }
        }
        for (const auto &[ref, object] : packed_) {
            const auto *type = find(object.dict(), "Type");
            if (!root.dict() && type && type->name() && *type->name() == "Catalog") { root = object; (void)ref; }
        }
        const auto *pages = find(root.dict(), "Pages");
        if (!pages) { broken(); }
        std::set<Ref> seen;
        walk(resolve(*pages), {}, result, seen, 0);
        return result;
    }
private:
    std::string_view data_;
    std::map<Ref, std::size_t> offsets_;
    std::map<Ref, Object> packed_, cache_;
    bool trailer_has(std::string_view key) {
        for (std::size_t at = data_.find("trailer"); at != std::string_view::npos; at = data_.find("trailer", at + 7)) {
            const auto end = data_.find(">>", at);
            if (end != std::string_view::npos && data_.substr(at, end - at).find(key) != std::string_view::npos) { return true; }
        }
        // Cross-reference streams carry the trailer keys in their own dictionary.
        for (std::size_t at = data_.find("/XRef"); at != std::string_view::npos; at = data_.find("/XRef", at + 5)) {
            const auto start = data_.rfind("<<", at), end = data_.find(">>", at);
            if (start != std::string_view::npos && end != std::string_view::npos && data_.substr(start, end - start).find(key) != std::string_view::npos) { return true; }
        }
        return false;
    }
    Object load(const Ref &ref) {
        Lexer lexer(data_, offsets_.at(ref));
        Object object;
        try { object = lexer.next(); } catch (const std::exception &) { return {}; }
        lexer.skip();
        if (data_.compare(lexer.at(), 6, "stream") == 0) {
            auto at = lexer.at() + 6;
            if (at < data_.size() && data_[at] == '\r') { ++at; }
            if (at < data_.size() && data_[at] == '\n') { ++at; }
            std::size_t length = std::string_view::npos;
            if (const auto *l = find(object.dict(), "Length")) {
                Object value = *l;
                if (const auto *r = value.ref()) { if (r->number != ref.number && offsets_.count(*r)) { Lexer inner(data_, offsets_.at(*r)); try { value = inner.next(); } catch (...) {} } }
                if (value.number() && *value.number() >= 0 && at + static_cast<std::size_t>(*value.number()) <= data_.size()) { length = static_cast<std::size_t>(*value.number()); }
            }
            // Trust /Length only when "endstream" follows it; otherwise search for the end.
            if (length != std::string_view::npos) {
                auto after = at + length;
                while (after < data_.size() && white(data_[after])) { ++after; }
                if (data_.compare(after, 9, "endstream") != 0) { length = std::string_view::npos; }
            }
            if (length == std::string_view::npos) {
                const auto end = data_.find("endstream", at);
                if (end == std::string_view::npos) { return object; }
                length = end - at;
            }
            object.stream = std::string(data_.substr(at, length));
            object.has_stream = true;
        }
        return object;
    }
    // ASCII85: groups of five characters '!'..'u' make four bytes, 'z' is four zero bytes, "~>" ends the data.
    static std::string ascii85(const std::string &data) {
        std::string out; std::uint32_t group = 0; int count = 0;
        for (const char c : data) {
            if (c == '~') { break; }
            if (white(c)) { continue; }
            if (c == 'z' && count == 0) { out.append(4, '\0'); continue; }
            if (c < '!' || c > 'u') { break; }
            group = group * 85 + static_cast<std::uint32_t>(c - '!');
            if (++count == 5) { for (int k = 3; k >= 0; --k) { out += static_cast<char>((group >> (8 * k)) & 0xFF); } group = 0; count = 0; }
        }
        if (count > 1) {
            for (int k = count; k < 5; ++k) { group = group * 85 + 84; }
            for (int k = 0; k < count - 1; ++k) { out += static_cast<char>((group >> (8 * (3 - k))) & 0xFF); }
        }
        return out;
    }
    static std::string ascii_hex(const std::string &data) {
        std::string out, digits;
        for (const char c : data) { if (c == '>') { break; } if (std::isxdigit(static_cast<unsigned char>(c))) { digits += c; } }
        if (digits.size() % 2) { digits += '0'; }
        for (std::size_t i = 0; i < digits.size(); i += 2) { out += static_cast<char>(std::stoi(digits.substr(i, 2), nullptr, 16)); }
        return out;
    }
    // LZW with early change, as in PDF and TIFF: codes grow from 9 to 12 bits, 256 clears, 257 ends.
    static std::string lzw(const std::string &data) {
        std::vector<std::string> table; std::string out, previous;
        const auto reset = [&] { table.clear(); for (int i = 0; i < 256; ++i) { table.emplace_back(1, static_cast<char>(i)); } table.emplace_back(); table.emplace_back(); };
        reset();
        std::uint32_t buffer = 0; int bits = 0, width = 9; std::size_t at = 0;
        for (;;) {
            while (bits < width && at < data.size()) { buffer = (buffer << 8) | static_cast<unsigned char>(data[at++]); bits += 8; }
            if (bits < width) { break; }
            const auto code = (buffer >> (bits - width)) & ((1u << width) - 1); bits -= width;
            if (code == 256) { reset(); width = 9; previous.clear(); continue; }
            if (code == 257) { break; }
            std::string entry;
            if (code < table.size() && !(code >= 258 && table[code].empty())) { entry = table[code]; }
            else if (code == table.size() && !previous.empty()) { entry = previous + previous[0]; }
            else { break; }
            out += entry;
            if (out.size() > 64u * 1024 * 1024) { break; }
            if (!previous.empty() && table.size() < 4096) { table.push_back(previous + entry[0]); }
            previous = entry;
            if (table.size() + 1 >= (1u << width) && width < 12) { ++width; }
        }
        return out;
    }
    static std::string inflate_zlib(const std::string &data) {
        if (data.size() < 2) { return {}; }
        std::string out;
        inflate::Decoder decoder(true);
        decoder.set_limit(64ULL * 1024 * 1024);
        try {
            decoder.feed(reinterpret_cast<const std::uint8_t *>(data.data()) + 2, data.size() - 2, [&](const std::uint8_t *bytes, std::size_t n) { out.append(reinterpret_cast<const char *>(bytes), n); });
        } catch (const std::exception &) {}
        return out;
    }
    void walk(const Object &node, Dict inherited, std::vector<Object> &result, std::set<Ref> &seen, int depth) {
        if (depth > 64 || result.size() > 100000) { broken(); }
        const auto *d = node.dict();
        if (!d) { return; }
        if (const auto *resources = find(d, "Resources")) { inherited["Resources"] = *resources; }
        const auto *kids = find(d, "Kids");
        const auto *type = find(d, "Type");
        if (!kids || (type && type->name() && *type->name() == "Page")) {
            auto page = std::make_shared<Dict>(*d);
            if (!page->count("Resources") && inherited.count("Resources")) { (*page)["Resources"] = inherited["Resources"]; }
            result.push_back(Object {page});
            return;
        }
        const auto list = resolve(*kids);
        if (!list.array()) { return; }
        for (const auto &kid : *list.array()) {
            if (const auto *r = kid.ref()) { if (!seen.insert(*r).second) { continue; } }
            walk(resolve(kid), inherited, result, seen, depth + 1);
        }
    }
};

// --- Fonts --------------------------------------------------------------------------------------------------------
// Code points for bytes 128-255 in WinAnsiEncoding (Latin-1 elsewhere) and MacRomanEncoding.
constexpr std::uint16_t win_ansi[32] = {0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
                                        0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178};
constexpr std::uint16_t mac_roman[128] = {
    0xC4, 0xC5, 0xC7, 0xC9, 0xD1, 0xD6, 0xDC, 0xE1, 0xE0, 0xE2, 0xE4, 0xE3, 0xE5, 0xE7, 0xE9, 0xE8, 0xEA, 0xEB, 0xED, 0xEC, 0xEE, 0xEF, 0xF1, 0xF3, 0xF2, 0xF4, 0xF6, 0xF5, 0xFA, 0xF9, 0xFB, 0xFC,
    0x2020, 0xB0, 0xA2, 0xA3, 0xA7, 0x2022, 0xB6, 0xDF, 0xAE, 0xA9, 0x2122, 0xB4, 0xA8, 0x2260, 0xC6, 0xD8, 0x221E, 0xB1, 0x2264, 0x2265, 0xA5, 0xB5, 0x2202, 0x2211, 0x220F, 0x3C0, 0x222B, 0xAA, 0xBA, 0x3A9, 0xE6, 0xF8,
    0xBF, 0xA1, 0xAC, 0x221A, 0x192, 0x2248, 0x2206, 0xAB, 0xBB, 0x2026, 0xA0, 0xC0, 0xC3, 0xD5, 0x152, 0x153, 0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019, 0xF7, 0x25CA, 0xFF, 0x178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02,
    0x2021, 0xB7, 0x201A, 0x201E, 0x2030, 0xC2, 0xCA, 0xC1, 0xCB, 0xC8, 0xCD, 0xCE, 0xCF, 0xCC, 0xD3, 0xD4, 0xF8FF, 0xD2, 0xDA, 0xDB, 0xD9, 0x131, 0x2C6, 0x2DC, 0xAF, 0x2D8, 0x2D9, 0x2DA, 0xB8, 0x2DD, 0x2DB, 0x2C7};
// Glyph names used in /Differences, for the letters and signs text actually uses.
const std::map<std::string, std::uint32_t> &glyph_names() {
    static const std::map<std::string, std::uint32_t> names = [] {
        std::map<std::string, std::uint32_t> m;
        const char *ascii[] = {"space", "exclam", "quotedbl", "numbersign", "dollar", "percent", "ampersand", "quotesingle", "parenleft", "parenright", "asterisk", "plus", "comma", "hyphen", "period", "slash",
                               "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "colon", "semicolon", "less", "equal", "greater", "question", "at"};
        for (int i = 0; i < 33; ++i) { m[ascii[i]] = static_cast<std::uint32_t>(0x20 + i); }
        for (char c = 'A'; c <= 'Z'; ++c) { m[std::string(1, c)] = static_cast<unsigned char>(c); }
        for (char c = 'a'; c <= 'z'; ++c) { m[std::string(1, c)] = static_cast<unsigned char>(c); }
        const std::pair<const char *, std::uint32_t> more[] = {
            {"bracketleft", '['}, {"backslash", '\\'}, {"bracketright", ']'}, {"asciicircum", '^'}, {"underscore", '_'}, {"grave", '`'}, {"braceleft", '{'}, {"bar", '|'}, {"braceright", '}'}, {"asciitilde", '~'},
            {"quoteright", 0x2019}, {"quoteleft", 0x2018}, {"quotedblleft", 0x201C}, {"quotedblright", 0x201D}, {"quotesinglbase", 0x201A}, {"quotedblbase", 0x201E}, {"endash", 0x2013}, {"emdash", 0x2014},
            {"bullet", 0x2022}, {"ellipsis", 0x2026}, {"dagger", 0x2020}, {"daggerdbl", 0x2021}, {"trademark", 0x2122}, {"copyright", 0xA9}, {"registered", 0xAE}, {"degree", 0xB0}, {"Euro", 0x20AC},
            {"fi", 0xFB01}, {"fl", 0xFB02}, {"ff", 0xFB00}, {"ffi", 0xFB03}, {"ffl", 0xFB04}, {"minus", 0x2212}, {"multiply", 0xD7}, {"divide", 0xF7}, {"section", 0xA7}, {"paragraph", 0xB6},
            {"sterling", 0xA3}, {"yen", 0xA5}, {"cent", 0xA2}, {"germandbls", 0xDF}, {"AE", 0xC6}, {"ae", 0xE6}, {"OE", 0x152}, {"oe", 0x153}, {"Oslash", 0xD8}, {"oslash", 0xF8}, {"dotlessi", 0x131},
            {"nbspace", 0xA0}, {"guillemotleft", 0xAB}, {"guillemotright", 0xBB}, {"periodcentered", 0xB7}, {"exclamdown", 0xA1}, {"questiondown", 0xBF}, {"florin", 0x192}, {"perthousand", 0x2030},
            {"Scaron", 0x160}, {"scaron", 0x161}, {"Zcaron", 0x17D}, {"zcaron", 0x17E}, {"Ydieresis", 0x178}, {"ydieresis", 0xFF}, {"Lslash", 0x141}, {"lslash", 0x142}, {"Eth", 0xD0}, {"eth", 0xF0},
            {"Thorn", 0xDE}, {"thorn", 0xFE}, {"mu", 0xB5}, {"plusminus", 0xB1}, {"onehalf", 0xBD}, {"onequarter", 0xBC}, {"threequarters", 0xBE}, {"ordfeminine", 0xAA}, {"ordmasculine", 0xBA}};
        for (const auto &[name, code] : more) { m[name] = code; }
        // Accented Latin letters: base letter plus accent name (eacute, Udieresis, ...), from their Latin-1 code points.
        const std::pair<const char *, std::uint32_t> accents[] = {{"grave", 0}, {"acute", 1}, {"circumflex", 2}, {"tilde", 3}, {"dieresis", 4}, {"ring", 5}};
        const std::pair<char, std::uint32_t> bases[] = {{'A', 0xC0}, {'a', 0xE0}};
        for (const auto &[letter, base] : bases) { for (const auto &[accent, offset] : accents) { m[std::string(1, letter) + accent] = base + offset; } }
        const std::pair<const char *, std::uint32_t> latin[] = {{"Ccedilla", 0xC7}, {"ccedilla", 0xE7}, {"Egrave", 0xC8}, {"Eacute", 0xC9}, {"Ecircumflex", 0xCA}, {"Edieresis", 0xCB}, {"egrave", 0xE8}, {"eacute", 0xE9},
            {"ecircumflex", 0xEA}, {"edieresis", 0xEB}, {"Igrave", 0xCC}, {"Iacute", 0xCD}, {"Icircumflex", 0xCE}, {"Idieresis", 0xCF}, {"igrave", 0xEC}, {"iacute", 0xED}, {"icircumflex", 0xEE}, {"idieresis", 0xEF},
            {"Ntilde", 0xD1}, {"ntilde", 0xF1}, {"Ograve", 0xD2}, {"Oacute", 0xD3}, {"Ocircumflex", 0xD4}, {"Otilde", 0xD5}, {"Odieresis", 0xD6}, {"ograve", 0xF2}, {"oacute", 0xF3}, {"ocircumflex", 0xF4},
            {"otilde", 0xF5}, {"odieresis", 0xF6}, {"Ugrave", 0xD9}, {"Uacute", 0xDA}, {"Ucircumflex", 0xDB}, {"Udieresis", 0xDC}, {"ugrave", 0xF9}, {"uacute", 0xFA}, {"ucircumflex", 0xFB}, {"udieresis", 0xFC},
            {"Yacute", 0xDD}, {"yacute", 0xFD}};
        for (const auto &[name, code] : latin) { m[name] = code; }
        return m;
    }();
    return names;
}
std::optional<std::uint32_t> glyph(const std::string &name) {
    if (const auto it = glyph_names().find(name); it != glyph_names().end()) { return it->second; }
    const auto hex_value = [](std::string_view h) -> std::optional<std::uint32_t> { if (h.empty() || h.size() > 6 || !std::all_of(h.begin(), h.end(), [](char c) { return std::isxdigit(static_cast<unsigned char>(c)); })) { return std::nullopt; } return static_cast<std::uint32_t>(std::stoul(std::string(h), nullptr, 16)); };
    if (name.rfind("uni", 0) == 0 && name.size() >= 7) { return hex_value(std::string_view(name).substr(3, 4)); }
    if (name.size() >= 5 && name[0] == 'u') { return hex_value(std::string_view(name).substr(1)); }
    const auto dot = name.find('.'); // "a.sc", "one.oldstyle"
    if (dot != std::string::npos && dot > 0) { return glyph(name.substr(0, dot)); }
    return std::nullopt;
}

void utf8(std::string &out, std::uint32_t c) {
    if (c == 0 || (c >= 0xD800 && c <= 0xDFFF) || c > 0x10FFFF) { return; }
    if (c < 0x80) { out += static_cast<char>(c); }
    else if (c < 0x800) { out += static_cast<char>(0xC0 | (c >> 6)); out += static_cast<char>(0x80 | (c & 63)); }
    else if (c < 0x10000) { out += static_cast<char>(0xE0 | (c >> 12)); out += static_cast<char>(0x80 | ((c >> 6) & 63)); out += static_cast<char>(0x80 | (c & 63)); }
    else { out += static_cast<char>(0xF0 | (c >> 18)); out += static_cast<char>(0x80 | ((c >> 12) & 63)); out += static_cast<char>(0x80 | ((c >> 6) & 63)); out += static_cast<char>(0x80 | (c & 63)); }
}
// UTF-16BE (with surrogate pairs) as used by ToUnicode maps.
std::string from_utf16(std::string_view bytes) {
    std::string out;
    for (std::size_t i = 0; i + 1 < bytes.size(); i += 2) {
        std::uint32_t c = static_cast<unsigned char>(bytes[i]) << 8 | static_cast<unsigned char>(bytes[i + 1]);
        if (c >= 0xD800 && c < 0xDC00 && i + 3 < bytes.size()) {
            const std::uint32_t low = static_cast<unsigned char>(bytes[i + 2]) << 8 | static_cast<unsigned char>(bytes[i + 3]);
            if (low >= 0xDC00 && low < 0xE000) { c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00); i += 2; }
        }
        utf8(out, c);
    }
    return out;
}
std::uint32_t code_of(std::string_view bytes) { std::uint32_t v = 0; for (const char c : bytes) { v = v << 8 | static_cast<unsigned char>(c); } return v; }

struct Font {
    int width = 1; // bytes per character code
    std::map<std::uint32_t, std::string> unicode; // ToUnicode
    std::uint32_t simple[256] {};
    bool has_simple = false;
    std::string decode(std::string_view bytes) const {
        std::string out;
        for (std::size_t i = 0; i + static_cast<std::size_t>(width) <= bytes.size(); i += static_cast<std::size_t>(width)) {
            const auto code = code_of(bytes.substr(i, static_cast<std::size_t>(width)));
            if (const auto it = unicode.find(code); it != unicode.end()) { out += it->second; continue; }
            if (width == 1) { utf8(out, has_simple ? simple[code] : code); }
        }
        return out;
    }
};

Font load_font(Document &doc, const Object &font_object) {
    Font font;
    const auto object = doc.resolve(font_object);
    const auto *d = object.dict();
    const auto *subtype = find(d, "Subtype");
    if (subtype && subtype->name() && *subtype->name() == "Type0") { font.width = 2; }
    // Standard encodings for simple fonts, then /Differences.
    if (font.width == 1) {
        font.has_simple = true;
        for (std::uint32_t c = 0; c < 256; ++c) { font.simple[c] = c >= 128 && c < 160 ? win_ansi[c - 128] : c; }
        if (const auto *encoding = find(d, "Encoding")) {
            const auto e = doc.resolve(*encoding);
            const auto *base = e.name() ? &e : find(e.dict(), "BaseEncoding");
            const std::string base_name = base && base->name() ? *base->name() : "";
            if (base_name == "MacRomanEncoding") { for (std::uint32_t c = 128; c < 256; ++c) { font.simple[c] = mac_roman[c - 128]; } }
            if (base_name == "StandardEncoding") { font.simple[0x27] = 0x2019; font.simple[0x60] = 0x2018; }
            if (const auto *diff = find(e.dict(), "Differences")) {
                const auto list = doc.resolve(*diff);
                std::uint32_t code = 0;
                if (list.array()) {
                    for (const auto &item : *list.array()) {
                        if (item.number()) { code = static_cast<std::uint32_t>(*item.number()); continue; }
                        if (item.name() && code < 256) { if (const auto g = glyph(*item.name())) { font.simple[code] = *g; } ++code; }
                    }
                }
            }
        }
    }
    // ToUnicode: bfchar and bfrange sections of the CMap.
    if (const auto *to_unicode = find(d, "ToUnicode")) {
        const auto stream = doc.resolve(*to_unicode);
        const auto body = doc.decoded(stream);
        Lexer lexer(body);
        std::vector<Object> stack;
        try {
            while (!lexer.done()) {
                auto item = lexer.next();
                const auto *op = item.op();
                if (!op) { stack.push_back(std::move(item)); if (stack.size() > 100000) { break; } continue; }
                if (*op == "endbfchar") {
                    for (std::size_t i = 0; i + 1 < stack.size(); i += 2) {
                        if (stack[i].string() && stack[i + 1].string()) { font.unicode[code_of(*stack[i].string())] = from_utf16(*stack[i + 1].string()); if (stack[i].string()->size() == 2 && font.width == 1) { font.width = 2; } }
                    }
                } else if (*op == "endbfrange") {
                    for (std::size_t i = 0; i + 2 < stack.size(); i += 3) {
                        if (!stack[i].string() || !stack[i + 1].string()) { continue; }
                        const auto low = code_of(*stack[i].string()), high = code_of(*stack[i + 1].string());
                        if (high < low || high - low > 65535) { continue; }
                        if (stack[i].string()->size() == 2 && font.width == 1) { font.width = 2; }
                        if (const auto *start = stack[i + 2].string()) {
                            auto target = *start;
                            for (auto code = low; code <= high; ++code) {
                                font.unicode[code] = from_utf16(target);
                                if (!target.empty()) { target.back() = static_cast<char>(static_cast<unsigned char>(target.back()) + 1); }
                            }
                        } else if (const auto *list = stack[i + 2].array()) {
                            auto code = low;
                            for (const auto &entry : *list) { if (entry.string() && code <= high) { font.unicode[code++] = from_utf16(*entry.string()); } }
                        }
                    }
                }
                if (*op == "endbfchar" || *op == "endbfrange" || *op == "begincodespacerange" || *op == "beginbfchar" || *op == "beginbfrange") { stack.clear(); }
            }
        } catch (const std::exception &) {}
    }
    return font;
}

// --- Page content -------------------------------------------------------------------------------------------------
class Page {
public:
    Page(Document &doc, std::string &text, std::size_t budget) : doc_(doc), text_(text), budget_(budget) {}
    void run(const std::string &content, const Object &resources, int depth = 0) {
        if (depth > 8) { return; }
        Lexer lexer(content);
        std::vector<Object> operands;
        Font *font = nullptr;
        std::map<std::string, Font> fonts;
        double line_y = 0, leading = 0; bool have_line = false;
        const auto resolved_resources = doc_.resolve(resources);
        const auto *res = resolved_resources.dict();
        const auto newline = [&] { if (!readable_.empty() && readable_.back() != '\n') { readable_ += '\n'; } };
        const auto move = [&](double y) { if (have_line && std::fabs(y - line_y) > 0.5) { newline(); } line_y = y; have_line = true; };
        const auto show = [&](const std::string &bytes) {
            if (!font) { return; }
            const auto piece = font->decode(bytes);
            readable_ += piece;
            if (text_.size() + readable_.size() > budget_) { fail("This PDF has too much text. Attach a smaller section."); }
        };
        while (!lexer.done()) {
            Object item;
            try { item = lexer.next(); } catch (const std::exception &) { break; }
            const auto *op = item.op();
            if (!op) { operands.push_back(std::move(item)); if (operands.size() > 10000) { operands.clear(); } continue; }
            const auto num = [&](std::size_t from_end) { return operands.size() >= from_end && operands[operands.size() - from_end].number() ? *operands[operands.size() - from_end].number() : 0.0; };
            if (*op == "BI") { // inline image: skip its data
                const auto end = content.find("EI", lexer.at());
                if (end == std::string::npos) { break; }
                lexer = Lexer(content, end + 2);
            } else if (*op == "Tf" && operands.size() >= 2 && operands[operands.size() - 2].name()) {
                const auto &name = *operands[operands.size() - 2].name();
                if (!fonts.count(name)) {
                    const auto font_resources = res ? doc_.resolve(*find_or_null(res, "Font")) : Object {};
                    const auto *font_dict = find(font_resources.dict(), name);
                    fonts[name] = font_dict ? load_font(doc_, *font_dict) : Font {};
                }
                font = &fonts[name];
            } else if (*op == "BT") { have_line = false; }
            else if (*op == "ET") { if (!readable_.empty() && readable_.back() != '\n' && readable_.back() != ' ') { readable_ += ' '; } }
            else if (*op == "Td" || *op == "TD") { if (*op == "TD") { leading = -num(1); } move(line_y + num(1)); }
            else if (*op == "Tm") { move(num(1)); }
            else if (*op == "TL") { leading = num(1); }
            else if (*op == "T*") { move(line_y - leading); }
            else if (*op == "Tj" && !operands.empty() && operands.back().string()) { show(*operands.back().string()); }
            else if ((*op == "'" || *op == "\"") && !operands.empty() && operands.back().string()) { move(line_y - leading); newline(); show(*operands.back().string()); }
            else if (*op == "TJ" && !operands.empty() && operands.back().array()) {
                for (const auto &part : *operands.back().array()) {
                    if (part.string()) { show(*part.string()); }
                    else if (part.number() && *part.number() < -200 && !readable_.empty() && readable_.back() != ' ') { readable_ += ' '; } // a wide gap is a space
                }
            } else if (*op == "Do" && !operands.empty() && operands.back().name() && res) {
                // Form XObjects carry their own content and resources.
                const auto xobjects = doc_.resolve(*find_or_null(res, "XObject"));
                const auto *entry = find(xobjects.dict(), *operands.back().name());
                if (entry) {
                    const auto form = doc_.resolve(*entry);
                    const auto *subtype = find(form.dict(), "Subtype");
                    if (subtype && subtype->name() && *subtype->name() == "Form" && form.has_stream) {
                        const auto *form_resources = find(form.dict(), "Resources");
                        run(doc_.decoded(form), form_resources ? *form_resources : resources, depth + 1);
                    }
                }
            }
            operands.clear();
        }
    }
    std::string readable() const { return readable_; }
private:
    Document &doc_; std::string &text_; std::size_t budget_; std::string readable_;
    static const Object *find_or_null(const Dict *d, const std::string &key) { static const Object none; const auto *o = find(d, key); return o ? o : &none; }
};
}

std::string pdf_text(std::string_view bytes) {
    if (bytes.substr(0, 5) != "%PDF-") { fail("The document contents do not match its file type."); }
    Document doc(bytes);
    const auto pages = doc.pages();
    if (pages.size() > 50) { fail("Attach a PDF section of 50 pages or fewer."); }
    std::string text;
    for (std::size_t n = 0; n < pages.size(); ++n) {
        text += "\n[Page " + std::to_string(n + 1) + "]\n";
        const auto *page = pages[n].dict();
        std::string content;
        if (const auto *contents = find(page, "Contents")) {
            const auto c = doc.resolve(*contents);
            if (c.has_stream) { content = doc.decoded(c); }
            if (const auto *list = c.array()) { for (const auto &part : *list) { content += doc.decoded(doc.resolve(part)); content += '\n'; } }
        }
        Page reader(doc, text, max_text_bytes);
        const auto *resources = find(page, "Resources");
        reader.run(content, resources ? *resources : Object {});
        const auto readable = reader.readable();
        if (agent::js_trim(readable).empty()) { fail("Page " + std::to_string(n + 1) + " has no readable text. Scanned or image-only pages need OCR first."); }
        text += readable;
        if (text.size() > max_text_bytes) { fail("This PDF has too much text. Attach a smaller section."); }
    }
    const auto trimmed = agent::js_trim(text);
    if (trimmed.size() > max_text_bytes) { fail("This document has too much text. Attach a smaller section (up to 24 KB of extracted text)."); }
    if (trimmed.empty()) { fail("No readable text was found. Scanned pages and images need OCR before attaching."); }
    return trimmed;
}
}
