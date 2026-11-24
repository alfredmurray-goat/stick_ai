# Stellan-Host native services

Stellan-Host is an original C++20 service host. It currently provides inference control and a separate workspace file service. It is **not yet a full Node.js replacement for the application**. The desktop HTTP API, agent orchestration, sessions and chat memory, GitHub, hooks, extension management, activation and updating still run in Node. Do not remove Node from app packages until those services have native implementations and pass their existing integration tests.

## Workspace service (development)

Build `stellan-host` with the runtime CMake project, then run:

```
stellan-host --workspace /absolute/project/root
```

This mode requires neither Node nor model weights. It uses private owner stdin/stdout; it does not open a network port. Do not expose its approval endpoint to an untrusted caller. Packages opting into the nativeHost capability now route agent file tools to this service. The app server and other services still require Node.

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

## Verified owner client

`experimental/stellan-runtime/workspace.mjs` is a development owner-pipe client. It checks a caller-supplied trusted executable hash before launch, verifies the native protocol greeting, bounds event framing, serializes operations and mediates write approvals. Cancellation closes the owner process and settles outstanding calls, including an unanswered approval. A failed approval callback denies the proposal; it does not leave a change queued. Binary identities must come from the trusted package manifest, never from the binary itself. The client opens no network service and does not send project text on command lines.

This client is temporary Node bootstrap code for integration tests, not a claim that the app no longer needs Node. The nativeHost package capability connects it to agent file tools; legacy packages without that capability retain the existing backend. This is not full Node removal. The final native app owner must replace that bootstrap and the remaining app services before Node can be removed. Cross-platform CTest includes the real native binary owner-client integration tests when Node is available.

## App file-tool integration

New release packaging passes `--native-host`, validates/copies the target Host executable and records it in the integrity manifest. Packages declaring `nativeHost:true` must contain a trusted executable record for every target; a missing or altered Host is an error, not a silent Node fallback. Universal assembly rejects mixed native/legacy platform packages. The bundled app client checks the executable SHA256 before each launch and retains the existing approval UI for writes/edits. The worker starts only on a file tool request, can reopen after idle exit before beginning a new operation, and closes on project switch/app shutdown. A host disconnect also cancels any outstanding approval UI, so it cannot leave a stale permission prompt. Started writes are never automatically replayed.

This port covers the agent's read/list/search/write/edit tools. Manual editor operations, the HTTP app server, agent orchestration, sessions/chat memory and integrations still need migration. Node remains packaged and used. Do not advertise Host as the full backend replacement yet. Real native file-tool integration tests run on Linux, Apple Silicon Mac and Windows; target-specific packaging and universal update tests retain manifest coverage. A source change does not mean the corresponding release has been delivered.

## Native session-state persistence

Development mode `stellan-host --state-store /absolute/private/state-root` stores bounded UTF-8 records without Node, a model or a network port. Supply an existing private directory dedicated to internal chat/session data. This is an owner-only persistence API, not a model-accessible project file tool. Do not expose its pipe to an untrusted caller or point it at an unrelated directory.

Each request is `ID state_get UUID` or `ID state_put UUID EXPECTED_REVISION HEX_TEXT`. IDs are positive integers; keys are lowercase UUIDs, text uses UTF-8 hexadecimal (`-` for empty), and records are at most64KiB. A missing record has revision `missing`; existing revisions are content SHA256s. A write must supply the current revision. Conflicts require reading and reconciling rather than silently overwriting. Empty existing records remain distinct from missing records. The service retains an exclusive OS lock for its store lifetime and rejects a second owner. Do not remove its `.owner.lock` while it is running. Lock files remain after exit; OS locks are released automatically.

Writes reuse the workspace service's temporary-file/flush/atomic-replacement path and cancellation-before-commit checks. These are opaque UTF-8 snapshots, not yet the app's structured ChatMemory schema, an encrypted vault, a multi-process database, or a promise of complete power-loss durability. The service does not validate that stored text is JSON. It does not train weights or turn memory into instructions/approval. The app still uses Node for its chat-memory implementation until schema/lifecycle/client integration is ported and tested.

`tests/state.py` checks exclusive ownership, restart persistence, revision conflicts, empty/missing distinction, UUID traversal rejection and UTF-8/size bounds on every native CTest platform.
