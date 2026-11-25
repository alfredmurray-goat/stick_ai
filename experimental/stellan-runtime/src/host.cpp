#include "session.hpp"
#include "workspace.hpp"
#include "mcp_bridge.hpp"
#include "front_door.hpp"
namespace stellan { int protocol_check(); }
#include "runtime.hpp"
#include <atomic>
#include <csignal>
#include <iostream>
#include <string_view>
#include <stdexcept>

namespace {
std::atomic_bool cancelled {false};
static_assert(std::atomic_bool::is_always_lock_free);
void interrupt(int) { cancelled.store(true, std::memory_order_relaxed); }
int entry(int argc, char **argv) {
    std::signal(SIGINT, interrupt); std::signal(SIGTERM, interrupt);
    try {
        // A disconnected owner must not leave inference running with nowhere to send it.
        std::cout.exceptions(std::ios::badbit | std::ios::failbit);
        if (argc >= 2 && std::string_view(argv[1]) == "--mcp-bridge") { return stellan::mcp_bridge(argc, argv); }
        if (argc >= 2 && std::string_view(argv[1]) == "--front-door") { return stellan::front_door(argc, argv); }
        if (argc == 2 && std::string_view(argv[1]) == "--protocol-check") { return stellan::protocol_check(); }
        if (argc == 3 && (std::string_view(argv[1]) == "--workspace" || std::string_view(argv[1]) == "--state-store")) {
            const std::string root(argv[2]);
            const auto service = std::string_view(argv[1]) == "--state-store" ? stellan::state_store_service : stellan::workspace_service;
            return service(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(root.data()), root.size())), [] { return cancelled.load(std::memory_order_relaxed); });
        }
        if (argc < 5 || argc > 11) throw std::runtime_error("Usage: stellan-host MODEL SHA256 THREADS CONTEXT [--lazy] [--token-ids] [--force-max] [--split PATH SHA256]");
        bool text = true, force = false, lazy = false;
        std::vector<std::string> split;
        for (int i = 5; i < argc; ++i) {
            const std::string_view option(argv[i]);
            if (option == "--token-ids" && text) text = false;
            else if (option == "--lazy" && !lazy) lazy = true;
            else if (option == "--force-max" && !force) force = true;
            else if (option == "--split" && split.empty() && i + 2 < argc) { split.emplace_back("--split"); split.emplace_back(argv[++i]); split.emplace_back(argv[++i]); }
            else throw std::runtime_error("Unknown or duplicate native-host option");
        }
        std::vector<std::string> storage {argv[0], "serve", argv[1], argv[2], argv[3], argv[4]};
        if (force) storage.emplace_back("--force-max");
        storage.insert(storage.end(), split.begin(), split.end());
        std::vector<char *> args;
        for (auto &value : storage) args.push_back(value.data());
        return stellan::session(static_cast<int>(args.size()), args.data(), [] { return cancelled.load(std::memory_order_relaxed); }, {true, text, lazy});
    } catch (const std::exception &error) { std::cerr << "stellan-host: " << error.what() << '\n'; return 1; }
}
}
#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
    std::vector<std::string> storage;
    for (int i = 0; i < argc; ++i) {
        const auto utf8 = std::filesystem::path(argv[i]).u8string();
        storage.emplace_back(reinterpret_cast<const char *>(utf8.data()), utf8.size());
    }
    std::vector<char *> args;
    for (auto &value : storage) args.push_back(value.data());
    return entry(argc, args.data());
}
#else
int main(int argc, char **argv) { return entry(argc, argv); }
#endif
