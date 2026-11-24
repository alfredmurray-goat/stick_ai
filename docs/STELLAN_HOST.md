# Stellan-Host native services

Stellan-Host is an original C++20 service host. It currently provides inference control and a separate workspace file service. It is **not yet a full Node.js replacement for the application**. The desktop HTTP API, agent orchestration, sessions and chat memory, GitHub, hooks, extension management, activation and updating still run in Node. Do not remove Node from app packages until those services have native implementations and pass their existing integration tests.

## Workspace service (development)

Build `stellan-host` with the runtime CMake project, then run:

```
stellan-host --workspace /absolute/project/root
```

This mode requires neither Node nor model weights. It uses private owner stdin/stdout; it does not open a network port. Do not expose its approval endpoint to an untrusted caller. The app does not yet route file tools to this service or ship the service as its backend.

Each request is one line: positive integer request ID, operation, then space-separated UTF-8 arguments encoded as hexadecimal. Use `-` for an empty argument. Responses are JSON lines carrying the request ID. Supported operations:

| Operation | Arguments | Behavior |
| --- | --- | --- |
| `read_file` | path | Strict UTF-8 regular file, at most 1 MiB; hard links rejected |
| `list_dir` | path | Sorted directory entries, at most 10,000 entries examined and 32 KiB returned |
| `search_files` | query | Literal search, at most 10,000 entries and 200 matching lines; skips `.stick`, `.git`, `node_modules` and symlinks |
| `write_file` | path, content | Returns an approval proposal without changing the project |
| `edit_file` | path, old, new | Requires exactly one nonempty old-text match, then proposes a change |
| `approve` | raw approval ID | Consumes a matching proposal, rechecks its resolved path and original contents, and commits the change |
| `deny` | raw approval ID | Consumes the proposal without writing |

`shutdown` exits. One pending change is allowed per service. Approval IDs cannot be replayed. Changes to the target while approval is pending require a new proposal. Writes use a same-directory temporary file, flush before replacement, check cancellation before commit, and preserve ordinary POSIX permission bits. File size, UTF-8 and path bounds apply independently of the protocol's 4 MiB input-line ceiling; an edit's combined hex arguments must fit that ceiling.

Paths are project-relative: no traversal, absolute paths, drive prefixes or access to the resolved `.stick` subtree. POSIX operations walk directory handles with `openat`/`O_NOFOLLOW`; listings use the opened directory rather than reopening its pathname. Windows rejects reparse parents and holds ancestor directory handles against rename during operations. These checks are not an OS sandbox against another process with permission to rearrange the project concurrently. Keep the existing process sandbox and user approvals when connecting this service to the agent.

`tests/workspace.py` exercises standalone reads, repeated listings/search, nested Unicode file creation, explicit approval/denial, replay rejection, tampering while approval is pending, unique edits, oversized/invalid text, reserved paths, and POSIX hard-link/symlink/FIFO rejection and executable permission preservation. Run through CTest on each supported platform before app adoption.

## Remaining migration gates

1. Package and verify the host binary on every target; add a cancellable owner-pipe client and route existing file tool tests through it.
2. Port agent orchestration, approvals, durable sessions and per-chat memory without losing cancellation or recovery behavior.
3. Port MCP ownership, GitHub/hooks/update and activation services, preserving credentials and integrity checks.
4. Move the authenticated app API and desktop lifecycle, then prove a complete packaged start/task/tool/update flow with no bundled or launched Node process.

Only the fourth gate permits calling Host the full app backend replacement. The gates are implementation work, not a feature reduction or a renamed Node process.
