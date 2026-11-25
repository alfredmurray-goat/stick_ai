#include "engine_client.hpp"
#include "protocol.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <stdexcept>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
namespace { using socket_t = SOCKET; constexpr socket_t invalid_socket = INVALID_SOCKET; void close_socket(socket_t s) { closesocket(s); } }
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
namespace { using socket_t = int; constexpr socket_t invalid_socket = -1; void close_socket(socket_t s) { close(s); } }
#endif

namespace stellan::engine {
namespace {
const std::string context_mark = "\n\n<project_context>\n";
const std::string omitted = "\n[Older context omitted to keep this request small; read focused files if needed.]";
std::size_t utf8_char_size(unsigned char c) { return c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4; }
// clipUtf8: whole code points while they fit in `limit` bytes.
std::string clip_utf8(const std::string &text, double limit) {
    if (static_cast<double>(text.size()) <= limit) { return text; }
    std::size_t at = 0;
    while (at < text.size()) {
        const auto size = utf8_char_size(static_cast<unsigned char>(text[at]));
        if (static_cast<double>(at + size) > limit) { break; }
        at += size;
    }
    return text.substr(0, at);
}
struct Socket {
    socket_t s = invalid_socket;
    ~Socket() { if (s != invalid_socket) { close_socket(s); } }
};
}

std::vector<agent::Message> bounded_tool_history(const std::vector<agent::Message> &messages, double limit) {
    std::vector<std::size_t> keep; // UTF-16 units, like the TypeScript
    std::vector<double> sizes;
    double total = 0;
    for (const auto &m : messages) {
        std::size_t k = 0;
        if (m.role == "system") { k = agent::js_length(m.content); }
        else if (m.role == "user" && m.content.rfind("<tool_result>", 0) != 0) {
            const auto mark = m.content.find(context_mark);
            k = mark == std::string::npos ? agent::js_length(m.content) : agent::js_length(std::string_view(m.content).substr(0, mark));
        }
        keep.push_back(k);
        const auto rest = agent::js_slice(m.content, k, agent::js_length(m.content));
        sizes.push_back(static_cast<double>(rest.size()));
        total += static_cast<double>(rest.size());
    }
    if (total <= limit) { return messages; }
    const double step = std::max(1.0, std::floor(limit / 2));
    const double drop = std::ceil((total - limit) / step) * step;
    double offset = 0;
    std::vector<agent::Message> out;
    for (std::size_t i = 0; i < messages.size(); ++i) {
        const auto &m = messages[i];
        const double size = sizes[i];
        if (!size) { out.push_back(m); continue; }
        const double start = offset; offset += size;
        if (start >= drop) { out.push_back(m); continue; }
        const auto head = agent::js_slice(m.content, 0, keep[i]);
        out.push_back({m.role, head + clip_utf8(m.content.substr(head.size()), std::max(0.0, offset - drop - 100)) + omitted});
    }
    return out;
}

Reply Client::complete(const std::vector<agent::Message> &messages, const std::function<void(std::string_view, bool)> &emit, const std::function<void(double)> &usage) const {
#ifdef _WIN32
    static const bool started = [] { WSADATA data; return WSAStartup(MAKEWORD(2, 2), &data) == 0; }();
    if (!started) { throw std::runtime_error("Cannot start networking"); }
#endif
    std::vector<agent::Message> all {{"system", system}};
    all.insert(all.end(), messages.begin(), messages.end());
    auto list = std::make_shared<json::Array>();
    for (const auto &m : bounded_tool_history(all, history_bytes)) {
        auto o = std::make_shared<json::Object>();
        o->emplace_back("role", json::Value {m.role});
        o->emplace_back("content", json::Value {m.content});
        list->push_back(json::Value {o});
    }
    auto body_object = std::make_shared<json::Object>();
    bool placed = false;
    for (const auto &[name, value] : options.object()) {
        body_object->emplace_back(name, value);
        if (name == "model") { body_object->emplace_back("messages", json::Value {list}); placed = true; }
    }
    if (!placed) { body_object->emplace_back("messages", json::Value {list}); }
    const auto body = json::stringify(json::Value {body_object});
    Socket connection;
    connection.s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connection.s == invalid_socket || connect(connection.s, reinterpret_cast<sockaddr *>(&address), sizeof address) != 0) {
        throw std::runtime_error("Cannot reach model. Restart the app; Stellan-Run is not answering.");
    }
    const auto request = "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:" + std::to_string(port) + "\r\nContent-Type: application/json\r\nAuthorization: Bearer " + key +
                         "\r\nAccept: text/event-stream\r\nConnection: close\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
    for (std::size_t sent = 0; sent < request.size();) {
        const auto n = send(connection.s, request.data() + sent, static_cast<int>(request.size() - sent), 0);
        if (n <= 0) { throw std::runtime_error("Cannot reach model. Restart the app; Stellan-Run is not answering."); }
        sent += static_cast<std::size_t>(n);
    }
    // Response: headers, then a (possibly chunked) Server-Sent Events stream.
    std::string raw, events, decoded;
    bool headers_done = false, chunked = false, done = false, finished = false;
    std::size_t size = 0, chunk_left = 0;
    bool in_chunk_size = true;
    std::string held;
    protocol::TaggedStream parser([&](std::string_view text, bool thinking) { emit(text, thinking); });
    const auto consume = [&](const std::string &event) {
        std::string data;
        std::size_t start = 0;
        bool first = true;
        while (start <= event.size()) {
            auto end = event.find('\n', start);
            if (end == std::string::npos) { end = event.size(); }
            const auto line = std::string_view(event).substr(start, end - start);
            if (line.rfind("data:", 0) == 0) {
                auto value = line.substr(5);
                while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) { value.remove_prefix(1); }
                if (!first) { data += '\n'; }
                data += value; first = false;
            }
            start = end + 1;
        }
        if (data.empty()) { return; }
        if (data == "[DONE]") { done = true; return; }
        const auto chunk = json::parse(data);
        if (const auto *u = chunk.find("usage"); u && u->is_object()) {
            const auto *p = u->find("prompt_tokens"), *c = u->find("completion_tokens");
            if (p && c && std::holds_alternative<double>(p->data) && std::holds_alternative<double>(c->data)) {
                const double a = std::get<double>(p->data), b = std::get<double>(c->data);
                if (a >= 0 && b >= 0 && a == std::floor(a) && b == std::floor(b)) { usage(a + b); }
            }
        }
        if (const auto *error = chunk.find("error"); error && !error->is_null()) { throw std::runtime_error("Stream error: " + json::stringify(*error)); }
        const auto *choices = chunk.find("choices");
        if (!choices || !choices->is_array() || choices->array().empty()) { return; }
        const auto &choice = choices->array()[0];
        if (const auto *reason = choice.find("finish_reason"); reason && reason->is_string()) {
            const auto &r = reason->string();
            if (r != "stop" && r != "length" && r != "tool_calls") { throw std::runtime_error("Incomplete model response: " + r); }
            finished = true;
        }
        const auto *delta = choice.find("delta");
        if (!delta || !delta->is_object()) { return; }
        for (const char *name : {"reasoning", "reasoning_content", "thinking"}) {
            if (const auto *r = delta->find(name); r && r->is_string() && !r->string().empty()) { emit(r->string(), true); break; }
        }
        if (const auto *calls = delta->find("tool_calls"); calls && calls->is_array() && !calls->array().empty()) {
            throw std::runtime_error("Native tool calls are unsupported; Stellan must write <tool_call> JSON in its text response");
        }
        if (const auto *content = delta->find("content"); content && content->is_string()) {
            // A JSON escape can split a surrogate pair across chunks; JavaScript joins the halves when it
            // concatenates, so hold a trailing high surrogate (3-byte WTF-8) until the next chunk.
            std::string text = held + content->string();
            held.clear();
            const auto high = [](std::string_view t, std::size_t i) { return static_cast<unsigned char>(t[i]) == 0xED && (static_cast<unsigned char>(t[i + 1]) & 0xF0) == 0xA0; };
            const auto low = [](std::string_view t, std::size_t i) { return static_cast<unsigned char>(t[i]) == 0xED && (static_cast<unsigned char>(t[i + 1]) & 0xF0) == 0xB0; };
            std::string joined;
            for (std::size_t i = 0; i < text.size();) {
                if (i + 3 <= text.size() && high(text, i)) {
                    if (i + 3 == text.size()) { held = text.substr(i); break; }
                    if (i + 6 <= text.size() && low(text, i + 3)) {
                        const unsigned hi = 0xD000u | ((static_cast<unsigned char>(text[i + 1]) & 0x3Fu) << 6) | (static_cast<unsigned char>(text[i + 2]) & 0x3Fu);
                        const unsigned lo = 0xD000u | ((static_cast<unsigned char>(text[i + 4]) & 0x3Fu) << 6) | (static_cast<unsigned char>(text[i + 5]) & 0x3Fu);
                        const unsigned c = 0x10000u + ((hi - 0xD800u) << 10) + (lo - 0xDC00u);
                        joined += static_cast<char>(0xF0 | (c >> 18)); joined += static_cast<char>(0x80 | ((c >> 12) & 0x3F));
                        joined += static_cast<char>(0x80 | ((c >> 6) & 0x3F)); joined += static_cast<char>(0x80 | (c & 0x3F));
                        i += 6; continue;
                    }
                }
                joined += text[i++];
            }
            if (!joined.empty()) { parser.push(joined); }
        }
    };
    const auto feed_events = [&](std::string_view bytes) {
        for (const char c : bytes) { if (c != '\r') { events += c; } }
        std::size_t boundary;
        while (!parser.complete && (boundary = events.find("\n\n")) != std::string::npos) {
            consume(events.substr(0, boundary));
            events.erase(0, boundary + 2);
        }
    };
    char buffer[16384];
    for (;;) {
        if (done || parser.complete) { break; }
        const auto n = recv(connection.s, buffer, sizeof buffer, 0);
        if (n <= 0) { break; }
        size += static_cast<std::size_t>(n);
        if (size > 4000000) { throw std::runtime_error("Model response exceeds 4 MB"); }
        raw.append(buffer, static_cast<std::size_t>(n));
        if (!headers_done) {
            const auto end = raw.find("\r\n\r\n");
            if (end == std::string::npos) { continue; }
            const auto head = raw.substr(0, end);
            const auto space = head.find(' ');
            const int status = space == std::string::npos ? 0 : std::atoi(head.c_str() + space + 1);
            if (status < 200 || status > 299) { throw std::runtime_error("Ollama HTTP " + std::to_string(status) + "; check model name and local Ollama configuration"); }
            std::string lower(head);
            for (auto &c : lower) { c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); }
            chunked = lower.find("transfer-encoding: chunked") != std::string::npos;
            raw.erase(0, end + 4);
            headers_done = true;
        }
        if (!chunked) { feed_events(raw); raw.clear(); continue; }
        for (;;) {
            if (in_chunk_size) {
                const auto line = raw.find("\r\n");
                if (line == std::string::npos) { break; }
                chunk_left = std::stoul(raw.substr(0, line), nullptr, 16);
                raw.erase(0, line + 2);
                if (chunk_left == 0) { raw.clear(); break; }
                in_chunk_size = false;
            }
            if (raw.size() < chunk_left + 2) {
                if (raw.size() > chunk_left) { break; }
                feed_events(raw); chunk_left -= raw.size(); raw.clear(); break;
            }
            feed_events(std::string_view(raw).substr(0, chunk_left));
            raw.erase(0, chunk_left + 2);
            in_chunk_size = true;
        }
    }
    if (!headers_done) { throw std::runtime_error("Cannot reach model. Restart the app; Stellan-Run is not answering."); }
    if (!parser.complete && !events.empty()) {
        bool blank = true;
        for (const char c : events) { if (c != ' ' && c != '\n' && c != '\t') { blank = false; } }
        if (!blank) { consume(events); }
    }
    if (!parser.complete && !done && !finished) { throw std::runtime_error("Truncated stream; no tools executed"); }
    if (!held.empty()) { parser.push(held); }
    parser.finish();
    const auto parsed = protocol::parse_step(parser.content, tools);
    return {parsed.content, parsed.step.kind == protocol::Step::Kind::done};
}
}
