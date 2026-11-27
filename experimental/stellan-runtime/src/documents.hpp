#pragma once
#include <string>
#include <string_view>
namespace stellan::documents {
/** Text of an attached PDF or DOCX, with the same limits and messages as portable/input-worker.mjs. */
std::string read(std::string_view kind, std::string_view bytes);
std::string pdf_text(std::string_view bytes);
/** stellan-host --read-document pdf|docx: bytes on stdin, {"text"} or {"error"} on stdout. */
int read_document(int argc, char **argv);
}
