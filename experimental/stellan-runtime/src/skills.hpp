#pragma once
#include <string>
namespace stellan::skills {
struct Parsed { std::string name, description, body; bool model_invocable = true, user_invocable = true; };
/** parseSkill from src/portable/skills.ts (SKILL.md text and the folder name as fallback); throws with its messages. */
Parsed parse(std::string text, const std::string &fallback);
/** stellan-host --parse-skill FALLBACK: SKILL.md on stdin, the parsed skill or {"error"} on stdout. */
int parse_skill(int argc, char **argv);
}
