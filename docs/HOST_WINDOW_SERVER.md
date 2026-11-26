# Moving the window server into Host (the last Node piece)

Status: planned, owner's choice (C++ rewrite, not an embedded JavaScript engine). Until this lands, Node stays on the
stick: it runs `src/portable/web.ts` (the window's API) and `src/portable/entry.ts` (the launcher).

## What already exists

- **`stellan-host --front-door`** (`experimental/stellan-runtime/src/front_door.cpp`) serves the window's files with the
  strict CSP and forwards every `/api/*` request to the Node server behind it (`src/portable/front-door.ts`).
- Host already does the work behind most actions: models (`--serve-model`), the agent loop (`--agent`), Max
  hand-offs, settings and chat storage (`--state-store`), file tools (`--workspace`), MCP (`--mcp-client`), HTTPS
  (`--fetch`), activation crypto (`--crypto`) and updates (`--update`).

## Why it can't move one action at a time

`web.ts` keeps one shared state ("the brain"): phase (choose, loading, ready, error), the running task and its
cancel handle, pending approvals, warm-up and resting, context usage per model, the event list and the long-poll
waiters behind `/api/state?wait=`. Nearly every route reads or changes it, so moving routes piecemeal would leave
Host and Node disagreeing. The brain moves first, then the routes around it.

## Order

1. **Contract first.** Run `tests/portable-web.test.ts` (and the other window tests) against either server,
   selected by an environment variable, so every step is checked against the behaviour Node has today.
2. **Brain and long-poll in Host:** state, events, `/api/state?wait=` (8 s hold, 40 ms batching), `/api/dismiss`,
   `/api/stop`. Front door answers these; everything else still goes to Node.
3. **Model lifecycle:** `/api/start`, warm-up, rest after `STICK_REST_MINUTES`, `/api/speed`, `/api/long-context`,
   `/api/faster`, using `--serve-model` directly.
4. **Tasks and approvals:** `/api/task`, `/api/approve`, `/api/cancel`, `/api/session/reset`, chat memory, using
   the native agent loop. Approvals stay mandatory; hooks may block but never approve.
5. **Settings and personal:** `/api/personal`, `/api/onboarded`, `/api/internet`, `/api/app-api*`, `/api/activate`.
6. **Files, skills, hooks, MCP:** `/api/files`, `/api/file`, `/api/skills/*`, `/api/hooks/*`, `/api/mcp/*`,
   `/api/extensions`.
7. **GitHub:** sign-in (token in Host memory only, never saved, logged or sent to the window), workspaces, review,
   publish.
8. **Launcher:** the desktop shell starts Host instead of `node app/launcher.cjs`.
9. **Node leaves the stick**, in the safe order in `docs/STELLAN_HOST.md`: only once sold sticks run an updater that
   accepts Host-only updates.

Each step ships on its own, behind `STICK_WINDOW_ON_NODE=1` as the way back, and only when the contract tests pass on
Linux, macOS and Windows and the desktop smoke test passes on all four platforms.

## Size

`web.ts` is about 530 dense lines with about 50 routes, plus what it imports (`personal.ts`, `skills.ts`,
`hooks.ts`, `mcp.ts`, `github-*.ts`, `activation.ts`, `app-api.ts`, `chat-memory.ts`). Realistically several long
sessions; steps 1 to 4 are the bulk of the risk.
