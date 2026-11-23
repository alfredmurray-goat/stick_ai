#pragma once

#include <functional>

namespace stellan {
int session(int argc, char **argv, const std::function<bool()> &cancelled);
}
