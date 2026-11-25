#include "protocol.hpp"
#include "json.hpp"
#include "agent_core.hpp"
#include "engine_client.hpp"

#include <iostream>
#include <stdexcept>
#include <memory>
#include <string>
#include <optional>

namespace stellan {
namespace {
json::Value str(const std::string &s) { return json::Value {s}; }
json::Value message_list(const std::vector<agent::Message> &messages) {
    auto list = std::make_shared<json::Array>();
    for (const auto &m : messages) {
        auto o = std::make_shared<json::Object>();
        o->emplace_back("role", str(m.role));
        o->emplace_back("content", str(m.content));
        list->push_back(json::Value {o});
    }
    return json::Value {list};
}
}
// stellan-host --loop-check: runs the native agent loop against scripted model replies and fake tools, and prints
// every event in order, so tests can compare it with runAgent driven by the same script.
int loop_check() {
    std::string line;
    while (std::getline(std::cin, line)) {
        const auto request = json::parse(line);
        std::vector<agent::Message> messages;
        for (const auto &m : request.find("messages")->array()) { messages.push_back({m.find("role")->string(), m.find("content")->string()}); }
        std::vector<std::string> replies, tools;
        for (const auto &r : request.find("replies")->array()) { replies.push_back(r.string()); }
        for (const auto &t : request.find("tools")->array()) { tools.push_back(t.string()); }
        auto events = std::make_shared<json::Array>();
        const auto event = [&](const char *type, std::vector<std::pair<std::string, json::Value>> fields) {
            auto o = std::make_shared<json::Object>();
            o->emplace_back("type", str(type));
            for (auto &f : fields) { o->push_back(std::move(f)); }
            events->push_back(json::Value {o});
        };
        std::size_t next_reply = 0;
        agent::LoopIO io;
        io.complete = [&](const std::vector<agent::Message> &sent) {
            event("prompt", {{"count", json::Value {static_cast<double>(sent.size())}}, {"last", str(sent.back().content)}});
            return next_reply < replies.size() ? replies[next_reply++] : std::string("<done>out of script</done>");
        };
        io.execute = [&](const std::string &name, const std::string &arguments) -> std::string {
            if (name == "run_shell") { throw std::runtime_error("Tool failed: " + arguments); }
            if (name == "search_files") { return std::string(40000, 'r') + "🦈"; }
            return name + " ran with " + arguments;
        };
        io.emit = [&](const std::string &text, bool thinking) { event("emit", {{"text", str(text)}, {"thinking", json::Value {thinking}}}); };
        io.log = [&](const std::string &text) { event("log", {{"text", str(text)}}); };
        io.save = [&](const std::vector<agent::Message> &batch) { event("save", {{"batch", message_list(batch)}}); };
        io.activity = [&](const agent::Activity &a) {
            std::vector<std::pair<std::string, json::Value>> fields {{"step", json::Value {static_cast<double>(a.step)}}, {"tool", str(a.tool)}, {"phase", str(a.phase)}};
            if (a.path) { fields.emplace_back("path", str(*a.path)); }
            if (a.detail) { fields.emplace_back("detail", str(*a.detail)); }
            if (a.result) { fields.emplace_back("result", str(*a.result)); }
            event("activity", std::move(fields));
        };
        const auto outcome = agent::run_agent(request.find("task")->string(), messages, static_cast<std::size_t>(std::get<double>(request.find("maxSteps")->data)),
            request.find("taskInstructions")->string(), std::get<double>(request.find("historyBytes")->data), tools,
            agent::Specialist {std::get<double>(request.find("totalBytes")->data), std::get<double>(request.find("recommendedBytes")->data), std::get<bool>(request.find("noSwap")->data)}, io);
        auto out = std::make_shared<json::Object>();
        out->emplace_back("outcome", str(outcome));
        out->emplace_back("messages", message_list(messages));
        out->emplace_back("events", json::Value {events});
        std::cout << json::stringify(json::Value {out}) << '\n';
    }
    std::cout.flush();
    return 0;
}
// stellan-host --agent: runs one task with the native agent loop. The first stdin line is the task
// {"task","messages","maxSteps","taskInstructions","historyBytes","tools","totalBytes","recommendedBytes","noSwap"}.
// The loop asks its owner for each model reply ({"event":"complete"} -> {"content"}) and each tool run
// ({"event":"tool"} -> {"result"} or {"error"}), so the app keeps its approval cards and engine. Other events are
// one-way. The last line is {"event":"done","outcome","messages"}.
int agent_mode() {
    std::string line;
    if (!std::getline(std::cin, line)) { throw std::runtime_error("No task given"); }
    const auto request = json::parse(line);
    std::vector<agent::Message> messages;
    for (const auto &m : request.find("messages")->array()) { messages.push_back({m.find("role")->string(), m.find("content")->string()}); }
    std::vector<std::string> tools;
    for (const auto &t : request.find("tools")->array()) { tools.push_back(t.string()); }
    const auto send = [](const char *type, std::vector<std::pair<std::string, json::Value>> fields) {
        auto o = std::make_shared<json::Object>();
        o->emplace_back("event", str(type));
        for (auto &f : fields) { o->push_back(std::move(f)); }
        std::cout << json::stringify(json::Value {o}) << '\n';
        std::cout.flush();
    };
    const auto answer = []() {
        std::string reply;
        if (!std::getline(std::cin, reply)) { throw std::runtime_error("The app stopped answering"); }
        return json::parse(reply);
    };
    agent::LoopIO io;
    // With "engine", Host asks Stellan-Run itself and streams the words to the app; otherwise the app answers.
    std::optional<engine::Client> client;
    if (const auto *e = request.find("engine")) {
        client.emplace();
        client->port = static_cast<int>(std::get<double>(e->find("port")->data));
        client->key = e->find("key")->string();
        client->system = e->find("system")->string();
        client->options = *e->find("options");
        client->history_bytes = std::get<double>(e->find("historyBytes")->data);
        client->tools = tools;
    }
    bool summary_streamed = false;
    io.complete = [&](const std::vector<agent::Message> &sent) {
        if (client) {
            send("thinking", {});
            const auto reply = client->complete(sent, [&](std::string_view text, bool thinking) { send("emit", {{"text", str(std::string(text))}, {"thinking", json::Value {thinking}}}); },
                                                [&](double tokens) { send("usage", {{"tokens", json::Value {tokens}}}); });
            summary_streamed = reply.summary_streamed;
            return reply.content;
        }
        send("complete", {{"messages", message_list(sent)}});
        const auto reply = answer();
        if (const auto *error = reply.find("error")) { throw std::runtime_error(error->string()); }
        return reply.find("content")->string();
    };
    io.execute = [&](const std::string &name, const std::string &arguments) -> std::string {
        send("tool", {{"name", str(name)}, {"arguments", str(arguments)}});
        const auto reply = answer();
        if (const auto *error = reply.find("error")) { throw std::runtime_error(error->string()); }
        return reply.find("result")->string();
    };
    // The app runs hooks and Max for Host when it says it has them; tokens and code stay in the app's processes.
    if (const auto *h = request.find("hooks"); h && std::get<bool>(h->data)) {
        io.before = [&](const std::string &name, const std::string &arguments) -> std::optional<std::string> {
            send("before", {{"name", str(name)}, {"arguments", str(arguments)}});
            const auto reply = answer();
            if (const auto *error = reply.find("error")) { throw std::runtime_error(error->string()); }
            const auto *blocked = reply.find("blocked");
            if (blocked && blocked->is_string() && !blocked->string().empty()) { return blocked->string(); }
            return std::nullopt;
        };
        io.after = [&](const std::string &name, const std::string &arguments, const std::string &result) {
            send("after", {{"name", str(name)}, {"arguments", str(arguments)}, {"result", str(result)}});
            const auto reply = answer();
            if (const auto *error = reply.find("error")) { throw std::runtime_error(error->string()); }
            return reply.find("notes")->string();
        };
    }
    io.code = [&](const std::string &task, const std::string &context) {
        send("code", {{"task", str(task)}, {"context", str(context)}});
        const auto reply = answer();
        if (const auto *error = reply.find("error")) { throw std::runtime_error(error->string()); }
        return reply.find("result")->string();
    };
    io.emit = [&](const std::string &text, bool thinking) { if (client && summary_streamed && !thinking) { return; } send("emit", {{"text", str(text)}, {"thinking", json::Value {thinking}}}); };
    io.log = [&](const std::string &text) { send("log", {{"text", str(text)}}); };
    io.save = [&](const std::vector<agent::Message> &batch) { send("save", {{"batch", message_list(batch)}}); };
    io.activity = [&](const agent::Activity &a) {
        std::vector<std::pair<std::string, json::Value>> fields {{"step", json::Value {static_cast<double>(a.step)}}, {"tool", str(a.tool)}, {"phase", str(a.phase)}};
        if (a.path) { fields.emplace_back("path", str(*a.path)); }
        if (a.detail) { fields.emplace_back("detail", str(*a.detail)); }
        if (a.result) { fields.emplace_back("result", str(*a.result)); }
        send("activity", std::move(fields));
    };
    const auto outcome = agent::run_agent(request.find("task")->string(), messages, static_cast<std::size_t>(std::get<double>(request.find("maxSteps")->data)),
        request.find("taskInstructions")->string(), std::get<double>(request.find("historyBytes")->data), tools,
        agent::Specialist {std::get<double>(request.find("totalBytes")->data), std::get<double>(request.find("recommendedBytes")->data), std::get<bool>(request.find("noSwap")->data), [&] { const auto *a = request.find("available"); return a && std::get<bool>(a->data); }()}, io);
    send("done", {{"outcome", str(outcome)}, {"messages", message_list(messages)}});
    return 0;
}
// stellan-host --history-check: one {"messages","limit"} per line; prints boundedToolHistory's result.
int history_check() {
    std::string line;
    while (std::getline(std::cin, line)) {
        const auto request = json::parse(line);
        std::vector<agent::Message> messages;
        for (const auto &m : request.find("messages")->array()) { messages.push_back({m.find("role")->string(), m.find("content")->string()}); }
        std::cout << json::stringify(message_list(engine::bounded_tool_history(messages, std::get<double>(request.find("limit")->data)))) << '\n';
    }
    std::cout.flush();
    return 0;
}
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
