#pragma once
#include <filesystem>
#include <functional>
namespace stellan {
int state_store_service(const std::filesystem::path &root, const std::function<bool()> &cancelled);
int workspace_service(const std::filesystem::path &root, const std::function<bool()> &cancelled);
}
