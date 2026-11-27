#pragma once
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace stellan::repo_archive {
struct TreeEntry { std::string path, mode, type, sha; };
/** Thrown with the exact message the app's GitHubError carries. */
struct GitHubError : std::runtime_error { using std::runtime_error::runtime_error; };
/** The port of repositoryFiles (src/portable/github-workspace.ts): every archive file checked against the pinned Git
 * tree by its Git blob hash, in archive order. Other failures (a damaged ZIP) throw std::runtime_error. */
std::vector<std::pair<std::string, std::string>> repository_files(std::string_view archive, const std::vector<TreeEntry> &tree);
std::string git_blob_sha1(std::string_view bytes);
/** --repository-files OUTDIR: JSON {archive, tree} on stdin; writes verified files under OUTDIR and prints
 * {"files":[...]} or {"error":..., "github":bool}. */
int main(int argc, char **argv);
}
