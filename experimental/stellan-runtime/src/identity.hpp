#pragma once
#include <optional>
#include <string>
#include <string_view>
#include "json.hpp"

namespace stellan::identity {
struct Mount { std::string mount, source; };
/** activation.ts mountFor: the deepest /proc/self/mountinfo entry holding path. */
std::optional<Mount> mount_for(std::string_view mountinfo, std::string_view path);
/** activation.ts findSerial: the USB serial above the disk in system_profiler's JSON. */
std::string find_serial(const json::Value &tree, std::string_view disk);
/** activation.ts stickIdentity: SHA-256 of "stick-ai:" + the stick's serial or volume ID, or "" if unknown. */
std::string stick_identity(const std::string &root);
/** --stick-identity ROOT, --identity-check (mountFor/findSerial on stdin, for tests), --activation-check ROOT KEY. */
int main(int argc, char **argv);
}
