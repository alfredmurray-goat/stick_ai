#pragma once
#include "json.hpp"
#include <exception>

namespace stellan::mcp {
struct WireError : std::exception { const char *what() const noexcept override; };
/** Envelope checks (mcp-wire.ts parseMcpMessage); throws WireError. */
void parse_message(const json::Value &input);
/** Initialization result, reduced to the fields a tool-only client uses (mcp-handshake.ts). */
json::Value parse_initialization(const json::Value &input);
/** tools/list result: {tools, nextCursor?} (mcp-results.ts). */
json::Value parse_tool_list(const json::Value &input);
/** tools/call result: {content, structuredContent?, isError?} (mcp-results.ts). */
json::Value parse_tool_result(const json::Value &input);
int wire_check();
}
