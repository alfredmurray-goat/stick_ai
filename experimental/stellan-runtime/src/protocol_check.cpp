#include "protocol.hpp"
#include "json.hpp"
#include "agent_core.hpp"

#include <iostream>
#include <memory>
#include <string>

namespace stellan {
// stellan-host --compact-check: one {"messages":[{role,content}], "budget"} per line; prints the compacted history.
int compact_check() {
    std::string line;
    while (std::getline(std::cin, line)) {
        const auto request = json::parse(line);
        std::vector<agent::Message> messages;
        for (const auto &m : request.find("messages")->array()) { messages.push_back({m.find("role")->string(), m.find("content")->string()}); }
        const auto compacted = agent::compact_history(messages, std::get<double>(request.find("budget")->data));
        auto list = std::make_shared<json::Array>();
        for (const auto &m : messages) {
            auto o = std::make_shared<json::Object>();
            o->emplace_back("role", json::Value {m.role});
            o->emplace_back("content", json::Value {m.content});
            list->push_back(json::Value {o});
        }
        auto out = std::make_shared<json::Object>();
        out->emplace_back("compacted", json::Value {static_cast<double>(compacted)});
        out->emplace_back("messages", json::Value {list});
        std::cout << json::stringify(json::Value {out}) << '\n';
    }
    std::cout.flush();
    return 0;
}
// stellan-host --protocol-check: one JSON request per stdin line {"content", "tools", "chunks"?}; prints what the
// native parser makes of it, so tests can compare it with the TypeScript parser on the same inputs.
int protocol_check() {
    std::string line;
    while (std::getline(std::cin, line)) {
        const auto request = json::parse(line);
        std::vector<std::string> tools;
        for (const auto &tool : request.find("tools")->array()) { tools.push_back(tool.string()); }
        const auto parsed = protocol::parse_step(request.find("content")->string(), tools);
        std::string text, thinking;
        if (const auto *chunks = request.find("chunks")) {
            protocol::TaggedStream stream([&](std::string_view piece, bool think) { (think ? thinking : text) += piece; });
            for (const auto &chunk : chunks->array()) { stream.push(chunk.string()); }
            stream.finish();
        }
        const char *kind = parsed.step.kind == protocol::Step::Kind::call ? "call" : parsed.step.kind == protocol::Step::Kind::done ? "done" : "error";
        auto object = std::make_shared<json::Object>();
        object->emplace_back("content", json::Value {parsed.content});
        object->emplace_back("kind", json::Value {std::string(kind)});
        object->emplace_back("name", json::Value {parsed.step.name});
        object->emplace_back("arguments", json::Value {parsed.step.arguments});
        object->emplace_back("summary", json::Value {parsed.step.summary});
        object->emplace_back("error", json::Value {parsed.step.error});
        object->emplace_back("text", json::Value {text});
        object->emplace_back("thinking", json::Value {thinking});
        std::cout << json::stringify(json::Value {object}) << '\n';
    }
    std::cout.flush();
    return 0;
}
}
