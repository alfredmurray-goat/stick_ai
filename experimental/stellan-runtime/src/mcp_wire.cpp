#include "mcp_wire.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <memory>
#include <stdexcept>

// Port of Stellan-Link's validators (src/portable/mcp-wire.ts, mcp-handshake.ts, mcp-results.ts) with the same
// acceptance on every input JSON.parse can produce; tests/mcp-wire-native.test.ts compares them.
namespace stellan::mcp {
namespace {
using json::Value;
[[noreturn]] void fail() { throw WireError(); }
bool object(const Value *v) { return v && v->is_object(); }
bool string(const Value *v) { return v && v->is_string(); }
bool number(const Value *v) { return v && std::holds_alternative<double>(v->data); }
bool boolean(const Value *v) { return v && std::holds_alternative<bool>(v->data); }
bool safe_integer(const Value *v) {
    if (!number(v)) { return false; }
    const double d = std::get<double>(v->data);
    return std::isfinite(d) && std::floor(d) == d && std::abs(d) <= 9007199254740991.0;
}
bool id(const Value *v) { return string(v) || safe_integer(v); }
bool has(const Value &v, std::string_view key) { return v.find(key) != nullptr; }

void bounded(const Value &value) {
    std::size_t nodes = 0, bytes = 0;
    const auto visit = [&](auto &self, const Value &item, int depth) -> void {
        if (++nodes > 100000 || depth > 64) { fail(); }
        if (item.is_string()) { bytes += item.string().size(); }
        else if (item.is_null() || std::holds_alternative<bool>(item.data)) { bytes += 5; }
        else if (number(&item)) { if (!std::isfinite(std::get<double>(item.data))) { fail(); } bytes += 24; }
        else if (item.is_array()) { for (const auto &entry : item.array()) { self(self, entry, depth + 1); } }
        else { for (const auto &[key, entry] : item.object()) { bytes += key.size() + 3; self(self, entry, depth + 1); } }
        if (bytes > 4 * 1024 * 1024) { fail(); }
    };
    visit(visit, value, 0);
}
void metadata(const Value &value) {
    const auto *meta = value.find("_meta");
    if (!meta) { return; }
    if (!meta->is_object()) { fail(); }
    if (const auto *token = meta->find("progressToken"); token && !id(token)) { fail(); }
    if (const auto *related = meta->find("io.modelcontextprotocol/related-task"); related && (!related->is_object() || !string(related->find("taskId")))) { fail(); }
}
// JavaScript String(value) for JSON values.
std::string js_string(const Value &v) {
    if (v.is_null()) { return "null"; }
    if (v.is_string()) { return v.string(); }
    if (boolean(&v)) { return std::get<bool>(v.data) ? "true" : "false"; }
    if (number(&v)) { return json::stringify(v); }
    if (v.is_object()) { return "[object Object]"; }
    std::string out;
    bool first = true;
    for (const auto &item : v.array()) { if (!first) { out += ','; } first = false; if (!item.is_null()) { out += js_string(item); } }
    return out;
}
void require(bool ok) { if (!ok) { fail(); } }
void optional_string(const Value &v, std::string_view key) { if (const auto *x = v.find(key)) { require(x->is_string()); } }
Value checked_result(const Value &v) {
    auto envelope = std::make_shared<json::Object>();
    envelope->emplace_back("jsonrpc", Value {std::string("2.0")});
    envelope->emplace_back("id", Value {0.0});
    envelope->emplace_back("result", v);
    parse_message(Value {envelope});
    require(v.is_object());
    return v;
}
void schema(const Value *v) {
    require(object(v) && string(v->find("type")) && v->find("type")->string() == "object");
    if (const auto *p = v->find("properties")) { require(p->is_object()); }
    if (const auto *r = v->find("required")) { require(r->is_array() && std::all_of(r->array().begin(), r->array().end(), [](const Value &x) { return x.is_string(); })); }
}
void annotations(const Value &v) {
    const auto *a = v.find("annotations");
    if (!a) { return; }
    require(a->is_object());
    if (const auto *audience = a->find("audience")) {
        require(audience->is_array() && std::all_of(audience->array().begin(), audience->array().end(), [](const Value &x) { return x.is_string() && (x.string() == "user" || x.string() == "assistant"); }));
    }
    if (const auto *priority = a->find("priority")) { require(number(priority) && std::get<double>(priority->data) >= 0 && std::get<double>(priority->data) <= 1); }
    optional_string(*a, "lastModified");
}
Value str(std::string s) { return Value {std::move(s)}; }
}

const char *WireError::what() const noexcept { return "Invalid or oversized MCP message"; }

void parse_message(const Value &input) {
    bounded(input);
    if (!input.is_object() || !string(input.find("jsonrpc")) || input.find("jsonrpc")->string() != "2.0") { fail(); }
    std::vector<std::string_view> keys;
    if (has(input, "method")) {
        keys = {"jsonrpc", "method", "id", "params"};
        if (!string(input.find("method")) || (has(input, "id") && !id(input.find("id")))) { fail(); }
        if (const auto *params = input.find("params")) { if (!params->is_object()) { fail(); } metadata(*params); }
    } else if (has(input, "result")) {
        keys = {"jsonrpc", "id", "result"};
        if (!id(input.find("id")) || !object(input.find("result"))) { fail(); }
        metadata(*input.find("result"));
    } else if (has(input, "error")) {
        keys = {"jsonrpc", "id", "error"};
        if (has(input, "id") && !id(input.find("id"))) { fail(); }
        const auto *error = input.find("error");
        if (!object(error) || !safe_integer(error->find("code")) || !string(error->find("message"))) { fail(); }
    } else { fail(); }
    for (const auto &[key, value] : input.object()) { if (std::find(keys.begin(), keys.end(), key) == keys.end()) { fail(); } }
}

Value parse_initialization(const Value &input) {
    checked_result(input);
    const auto *capabilities = input.find("capabilities"), *server = input.find("serverInfo");
    if (!string(input.find("protocolVersion")) || !object(capabilities) || !object(server)) { fail(); }
    if (!string(server->find("name")) || !string(server->find("version"))) { fail(); }
    for (const char *key : {"title", "websiteUrl", "description"}) { if (const auto *x = server->find(key); x && !x->is_string()) { fail(); } }
    if (const auto *x = input.find("instructions"); x && !x->is_string()) { fail(); }
    const auto *tools = capabilities->find("tools");
    if (tools && (!tools->is_object() || (has(*tools, "listChanged") && !boolean(tools->find("listChanged"))))) { fail(); }
    auto capability = std::make_shared<json::Object>();
    if (tools) {
        auto t = std::make_shared<json::Object>();
        if (const auto *changed = tools->find("listChanged")) { t->emplace_back("listChanged", *changed); }
        capability->emplace_back("tools", Value {t});
    }
    auto info = std::make_shared<json::Object>();
    info->emplace_back("name", *server->find("name"));
    info->emplace_back("version", *server->find("version"));
    auto out = std::make_shared<json::Object>();
    out->emplace_back("protocolVersion", *input.find("protocolVersion"));
    out->emplace_back("capabilities", Value {capability});
    out->emplace_back("serverInfo", Value {info});
    return Value {out};
}

Value parse_tool_list(const Value &v) {
    checked_result(v);
    const auto *tools = v.find("tools");
    require(tools && tools->is_array());
    optional_string(v, "nextCursor");
    for (const auto &t : tools->array()) {
        require(t.is_object() && string(t.find("name")) && !t.find("name")->string().empty());
        schema(t.find("inputSchema"));
        optional_string(t, "description");
        optional_string(t, "title");
        if (const auto *output = t.find("outputSchema")) { schema(output); }
        if (const auto *a = t.find("annotations")) {
            require(a->is_object());
            optional_string(*a, "title");
            for (const char *key : {"readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"}) { if (const auto *x = a->find(key)) { require(boolean(x)); } }
        }
        if (const auto *e = t.find("execution")) {
            require(e->is_object());
            if (const auto *support = e->find("taskSupport")) {
                const auto text = js_string(*support);
                require(text == "forbidden" || text == "optional" || text == "required");
            }
        }
    }
    auto out = std::make_shared<json::Object>();
    out->emplace_back("tools", *tools);
    if (const auto *cursor = v.find("nextCursor")) { out->emplace_back("nextCursor", *cursor); }
    return Value {out};
}

Value parse_tool_result(const Value &v) {
    checked_result(v);
    const auto *content = v.find("content");
    require(!content || content->is_array());
    if (const auto *e = v.find("isError")) { require(boolean(e)); }
    if (const auto *s = v.find("structuredContent")) { require(s->is_object()); }
    static const Value empty {std::make_shared<json::Array>()};
    const auto &items = content ? *content : empty;
    for (const auto &c : items.array()) {
        require(c.is_object() && string(c.find("type")));
        annotations(c);
        const auto &type = c.find("type")->string();
        if (type == "text") { require(string(c.find("text"))); }
        else if (type == "image" || type == "audio") { require(string(c.find("data")) && string(c.find("mimeType"))); }
        else if (type == "resource_link") { require(string(c.find("uri")) && string(c.find("name"))); optional_string(c, "description"); optional_string(c, "mimeType"); }
        else if (type == "resource") {
            const auto *r = c.find("resource");
            require(object(r) && string(r->find("uri")));
            optional_string(*r, "mimeType"); optional_string(*r, "text"); optional_string(*r, "blob");
            require(string(r->find("text")) || string(r->find("blob")));
        } else { fail(); }
    }
    auto out = std::make_shared<json::Object>();
    out->emplace_back("content", items);
    if (const auto *s = v.find("structuredContent")) { out->emplace_back("structuredContent", *s); }
    if (const auto *e = v.find("isError")) { out->emplace_back("isError", *e); }
    return Value {out};
}

// stellan-host --mcp-check: one {"kind","value"} per line; prints {"ok":true,"value"} or {"ok":false,"error"}.
int wire_check() {
    std::string line;
    while (std::getline(std::cin, line)) {
        auto out = std::make_shared<json::Object>();
        try {
            const auto request = json::parse(line);
            const auto &kind = request.find("kind")->string();
            const auto &value = *request.find("value");
            Value result = value;
            if (kind == "message") { parse_message(value); }
            else if (kind == "init") { result = parse_initialization(value); }
            else if (kind == "tools") { result = parse_tool_list(value); }
            else { result = parse_tool_result(value); }
            out->emplace_back("ok", Value {true});
            out->emplace_back("value", result);
        } catch (const std::exception &error) {
            out->clear();
            out->emplace_back("ok", Value {false});
            out->emplace_back("error", str(error.what()));
        }
        std::cout << json::stringify(Value {out}) << '\n';
    }
    std::cout.flush();
    return 0;
}
}
