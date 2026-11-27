#include "documents.hpp"

#include "agent_core.hpp"
#include "inflate.hpp"
#include "json.hpp"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

// Attached documents to text, as portable/input-worker.mjs does: the same limits, matching rules and messages, so
// the app shows the same text and the same errors whichever reads the file.
namespace stellan::documents {
namespace {
constexpr std::size_t max_text_bytes = 24000;
[[noreturn]] void fail(const std::string &message) { throw std::runtime_error(message); }

std::string bounded(const std::string &text) {
    if (text.size() > max_text_bytes) { fail("This document has too much text. Attach a smaller section (up to 24 KB of extracted text)."); }
    if (agent::js_trim(text).empty()) { fail("No readable text was found. Scanned pages and images need OCR before attaching."); }
    return text;
}

// new TextDecoder('utf-8', { fatal: true }): any invalid sequence is an error.
void require_utf8(std::string_view s) {
    for (std::size_t i = 0; i < s.size();) {
        const auto b = static_cast<unsigned char>(s[i]);
        std::size_t n = b < 0x80 ? 1 : b >= 0xC2 && b < 0xE0 ? 2 : b >= 0xE0 && b < 0xF0 ? 3 : b >= 0xF0 && b < 0xF5 ? 4 : 0;
        if (n == 0 || i + n > s.size()) { fail("The encoded data was not valid for encoding utf-8"); }
        std::uint32_t c = n == 1 ? b : n == 2 ? b & 0x1F : n == 3 ? b & 0x0F : b & 0x07;
        for (std::size_t k = 1; k < n; ++k) {
            const auto t = static_cast<unsigned char>(s[i + k]);
            if ((t & 0xC0) != 0x80) { fail("The encoded data was not valid for encoding utf-8"); }
            c = (c << 6) | (t & 0x3F);
        }
        if ((n == 3 && (c < 0x800 || (c >= 0xD800 && c <= 0xDFFF))) || (n == 4 && (c < 0x10000 || c > 0x10FFFF))) { fail("The encoded data was not valid for encoding utf-8"); }
        i += n;
    }
}
void append_utf8(std::string &out, std::uint32_t c) {
    if (c < 0x80) { out += static_cast<char>(c); }
    else if (c < 0x800) { out += static_cast<char>(0xC0 | (c >> 6)); out += static_cast<char>(0x80 | (c & 63)); }
    else if (c < 0x10000) { out += static_cast<char>(0xE0 | (c >> 12)); out += static_cast<char>(0x80 | ((c >> 6) & 63)); out += static_cast<char>(0x80 | (c & 63)); }
    else { out += static_cast<char>(0xF0 | (c >> 18)); out += static_cast<char>(0x80 | ((c >> 12) & 63)); out += static_cast<char>(0x80 | ((c >> 6) & 63)); out += static_cast<char>(0x80 | (c & 63)); }
}
char lower(char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; }
bool starts_with_ci(std::string_view s, std::size_t at, std::string_view word) {
    if (at + word.size() > s.size()) { return false; }
    for (std::size_t i = 0; i < word.size(); ++i) { if (lower(s[at + i]) != word[i]) { return false; } }
    return true;
}
bool contains_ci(std::string_view s, std::string_view word) { for (std::size_t i = 0; i + word.size() <= s.size(); ++i) { if (starts_with_ci(s, i, word)) { return true; } } return false; }

// entities(): &(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos); case-insensitively; anything else is left as written.
std::string entities(std::string_view text) {
    std::string out;
    for (std::size_t i = 0; i < text.size();) {
        if (text[i] == '&') {
            const auto semi = text.find(';', i + 1);
            if (semi != std::string_view::npos) {
                const auto name = text.substr(i + 1, semi - i - 1);
                std::string low; for (const char c : name) { low += lower(c); }
                const auto hex = [](char c) { return (c >= '0' && c <= '9') || (lower(c) >= 'a' && lower(c) <= 'f'); };
                const auto dec = [](char c) { return c >= '0' && c <= '9'; };
                bool numeric = false; std::uint64_t point = 0; bool overflow = false;
                if (low.size() > 2 && low[0] == '#' && low[1] == 'x' && std::all_of(low.begin() + 2, low.end(), hex)) {
                    numeric = true;
                    for (std::size_t k = 2; k < low.size(); ++k) { point = point * 16 + static_cast<std::uint64_t>(low[k] <= '9' ? low[k] - '0' : low[k] - 'a' + 10); if (point > 0x10FFFF) { overflow = true; } }
                } else if (low.size() > 1 && low[0] == '#' && std::all_of(low.begin() + 1, low.end(), dec)) {
                    numeric = true;
                    for (std::size_t k = 1; k < low.size(); ++k) { point = point * 10 + static_cast<std::uint64_t>(low[k] - '0'); if (point > 0x10FFFF) { overflow = true; } }
                }
                if (numeric) {
                    if (overflow || point < 1 || point > 0x10FFFF || (point >= 0xD800 && point <= 0xDFFF)) { fail("Invalid document character."); }
                    append_utf8(out, static_cast<std::uint32_t>(point)); i = semi + 1; continue;
                }
                const char *named = low == "amp" ? "&" : low == "lt" ? "<" : low == "gt" ? ">" : low == "quot" ? "\"" : low == "apos" ? "'" : nullptr;
                if (named) { out += named; i = semi + 1; continue; }
            }
        }
        out += text[i++];
    }
    return out;
}

bool word_char(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'; }
bool js_space(std::string_view s, std::size_t at) {
    const auto c = static_cast<unsigned char>(s[at]);
    if (c == ' ' || (c >= 0x09 && c <= 0x0D)) { return true; }
    if (c == 0xC2 && at + 1 < s.size() && static_cast<unsigned char>(s[at + 1]) == 0xA0) { return true; }
    return false;
}

std::string docx_text(std::string_view xml) {
    require_utf8(xml);
    if (contains_ci(xml, "<!doctype") || contains_ci(xml, "<!entity")) { fail("External XML entities are unsupported."); }
    std::string clean;
    for (std::size_t i = 0; i < xml.size();) {
        if (xml.compare(i, 4, "<!--") == 0) { const auto end = xml.find("-->", i + 4); if (end != std::string_view::npos) { i = end + 3; continue; } }
        clean += xml[i++];
    }
    const std::string_view x(clean);
    std::string text;
    for (std::size_t i = 0; i < x.size();) {
        if (x[i] != '<') { ++i; continue; }
        std::size_t end = 0; std::string piece; bool matched = false;
        // <w:t(?:\s[^>]*)?>([\s\S]*?)</w:t>
        if (x.compare(i, 4, "<w:t") == 0 && i + 4 < x.size() && (x[i + 4] == '>' || js_space(x, i + 4))) {
            const auto open = x.find('>', i + 4);
            const auto close = open == std::string_view::npos ? open : x.find("</w:t>", open + 1);
            if (close != std::string_view::npos) { piece = entities(x.substr(open + 1, close - open - 1)); end = close + 6; matched = true; }
        }
        // <w:(tab|br)\b[^>]*/>
        if (!matched) {
            for (const std::string_view tag : {std::string_view("<w:tab"), std::string_view("<w:br")}) {
                if (x.compare(i, tag.size(), tag) == 0 && (i + tag.size() >= x.size() || !word_char(x[i + tag.size()]))) {
                    const auto gt = x.find('>', i + tag.size());
                    if (gt != std::string_view::npos && gt > i + tag.size() - 1 && x[gt - 1] == '/' && gt - 1 >= i + tag.size()) { piece = tag == "<w:tab" ? "\t" : "\n"; end = gt + 1; matched = true; break; }
                }
            }
        }
        if (!matched && (x.compare(i, 6, "</w:p>") == 0 || x.compare(i, 7, "</w:tr>") == 0)) { piece = "\n"; end = i + (x[i + 4] == 'p' ? 6 : 7); matched = true; }
        if (!matched && x.compare(i, 7, "</w:tc>") == 0) { piece = "\t"; end = i + 7; matched = true; }
        if (!matched) { ++i; continue; }
        text += piece; i = end;
        if (text.size() > max_text_bytes) { bounded(text); }
    }
    return bounded(agent::js_trim(text));
}

std::uint32_t u16(std::string_view b, std::size_t at) { if (at + 2 > b.size()) { fail("This is not a readable DOCX document."); } return static_cast<unsigned char>(b[at]) | static_cast<std::uint32_t>(static_cast<unsigned char>(b[at + 1])) << 8; }
std::uint32_t u32(std::string_view b, std::size_t at) { return u16(b, at) | u16(b, at + 2) << 16; }

// The one ZIP entry word/document.xml, after the same entry-count and size limits as the Node reader.
std::string document_xml(std::string_view zip) {
    if (zip.size() < 22) { fail("This is not a readable DOCX document."); }
    std::size_t eocd = std::string_view::npos;
    for (std::size_t back = 22; back <= std::min<std::size_t>(zip.size(), 22 + 65535); ++back) { if (u32(zip, zip.size() - back) == 0x06054B50) { eocd = zip.size() - back; break; } }
    if (eocd == std::string_view::npos) { fail("This is not a readable DOCX document."); }
    const auto count = u16(zip, eocd + 10);
    auto at = static_cast<std::size_t>(u32(zip, eocd + 16));
    std::size_t entries = 0;
    for (std::uint32_t n = 0; n < count; ++n) {
        if (u32(zip, at) != 0x02014B50) { fail("This is not a readable DOCX document."); }
        if (++entries > 1024) { fail("The document contains too many ZIP entries."); }
        const auto method = u16(zip, at + 10); const auto packed = u32(zip, at + 20), size = u32(zip, at + 24);
        const auto name_length = u16(zip, at + 28), extra = u16(zip, at + 30), comment = u16(zip, at + 32);
        const auto local = static_cast<std::size_t>(u32(zip, at + 42));
        if (at + 46 + name_length > zip.size()) { fail("This is not a readable DOCX document."); }
        const auto name = zip.substr(at + 46, name_length);
        at += 46 + name_length + extra + comment;
        if (name != "word/document.xml") { continue; }
        if (size > 4u * 1024 * 1024) { fail("The expanded document is too large."); }
        if (u32(zip, local) != 0x04034B50) { fail("This is not a readable DOCX document."); }
        const auto data = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
        if (data + packed > zip.size()) { fail("This is not a readable DOCX document."); }
        const auto body = zip.substr(data, packed);
        if (method == 0) { if (packed != size) { fail("This is not a readable DOCX document."); } return std::string(body); }
        if (method != 8) { fail("This is not a readable DOCX document."); }
        std::string out;
        inflate::Decoder decoder(true);
        decoder.set_limit(size);
        try {
            decoder.feed(reinterpret_cast<const std::uint8_t *>(body.data()), body.size(), [&](const std::uint8_t *bytes, std::size_t n) { out.append(reinterpret_cast<const char *>(bytes), n); });
        } catch (const std::exception &) { fail("This is not a readable DOCX document."); }
        if (!decoder.finished() || out.size() != size) { fail("This is not a readable DOCX document."); }
        return out;
    }
    fail("This is not a readable DOCX document.");
}
}

std::string read(std::string_view kind, std::string_view bytes) {
    if (kind == "docx") { return docx_text(document_xml(bytes)); }
    if (kind == "pdf") { return pdf_text(bytes); }
    fail("Unsupported document type.");
}

// stellan-host --read-document pdf|docx: the file's bytes on stdin; {"text":...} or {"error":...} on stdout.
int read_document(int argc, char **argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
#endif
    const std::string kind = argc > 2 ? argv[2] : "";
    const std::string bytes((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
    try {
        const auto text = read(kind, bytes); // read fully first, so an error never lands inside a half-written reply
        std::cout << "{\"text\":" << json::stringify_string(text) << "}\n";
    } catch (const std::exception &error) {
        std::cout << "{\"error\":" << json::stringify_string(error.what()) << "}\n";
    }
    return 0;
}
}
