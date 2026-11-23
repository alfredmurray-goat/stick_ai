#include "session.hpp"
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
        if (argc < 5 || argc > 10) throw std::runtime_error("Usage: stellan-host MODEL SHA256 THREADS CONTEXT [--token-ids] [--force-max] [--split PATH SHA256]");
        bool text = true, force = false;
        std::vector<std::string> split;
        for (int i = 5; i < argc; ++i) {
            const std::string_view option(argv[i]);
            if (option == "--token-ids" && text) text = false;
            else if (option == "--force-max" && !force) force = true;
            else if (option == "--split" && split.empty() && i + 2 < argc) { split.emplace_back("--split"); split.emplace_back(argv[++i]); split.emplace_back(argv[++i]); }
            else throw std::runtime_error("Unknown or duplicate native-host option");
        }
        std::vector<std::string> storage {argv[0], "serve", argv[1], argv[2], argv[3], argv[4]};
        if (force) storage.emplace_back("--force-max");
        storage.insert(storage.end(), split.begin(), split.end());
        std::vector<char *> args;
        for (auto &value : storage) args.push_back(value.data());
        return stellan::session(static_cast<int>(args.size()), args.data(), [] { return cancelled.load(std::memory_order_relaxed); }, {true, text});
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
