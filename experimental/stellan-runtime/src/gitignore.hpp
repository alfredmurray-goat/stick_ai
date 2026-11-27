#pragma once
#include <memory>
#include <string>
namespace stellan::gitignore {
/** .gitignore matching exactly as the `ignore` package (7.0.5) used by github-workspace.ts. */
class Ignore {
public:
    Ignore();
    ~Ignore();
    Ignore(Ignore &&) noexcept;
    Ignore &operator=(Ignore &&) noexcept;
    /** Adds the rules of one .gitignore file. */
    void add(const std::string &text);
    /** Whether a relative path (folders end with "/") is ignored; throws for empty or non-relative paths. */
    bool ignores(const std::string &path) const;
private:
    struct State;
    std::unique_ptr<State> state_;
};
/** stellan-host --gitignore-check: for tests against the `ignore` package. */
int check();
}
