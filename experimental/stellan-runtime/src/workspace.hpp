#pragma once
#include <filesystem>
#include <functional>
namespace stellan {
int workspace_service(const std::filesystem::path &root, const std::function<bool()> &cancelled);
}
