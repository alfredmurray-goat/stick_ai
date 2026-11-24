#pragma once

#include <functional>

namespace stellan {
struct SessionOptions { bool host = false; bool text = false; bool lazy = false; };
int session(int argc, char **argv, const std::function<bool()> &cancelled, SessionOptions options = {});
}
