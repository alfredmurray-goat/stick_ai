# Moving the window server into Host (the last Node piece)

Status: planned, owner's choice (C++ rewrite, not an embedded JavaScript engine). Until this lands, Node stays on the
stick: it runs `src/portable/web.ts` (the window's API) and `src/portable/entry.ts` (the launcher).

## What already exists

- **`stellan-host --front-door`** (`experimental/stellan-runtime/src/front_door.cpp`) serves the window's files with the
  strict CSP and forwards every `/api/*` request to the Node server behind it (`src/portable/front-door.ts`).
- Host already does the work behind most actions: models (`--serve-model`), the agent loop (`--agent`), Max
  hand-offs, settings and chat storage (`--state-store`), file tools (`--workspace`), MCP (`--mcp-client`), HTTPS
  (`--fetch`), activation crypto (`--crypto`) and updates (`--update`).

## Order changed: bottom-up

The brain's view includes live parts owned by other pieces (for example which MCP servers are connected), so moving
the brain first would mean two processes keeping each other's live state in sync. Instead each piece the window
relies on moves into Host first, with Node calling Host for it (as the agent loop, MCP, storage, HTTPS and updates
already did), and the brain and routes move last as a thin layer on top. The contract test still decides the final
switch.

Pieces still on Node, in order: attached documents (done: `--read-document`), skills (the SKILL.md reader is done:
`--parse-skill`, `src/skills.cpp`, identical to the app's on 39 awkward headers and 70 real skill packs; the skills
list, enable and save move with the brain), hooks (done: `--run-hook` and `--hook-config`, used by the app), `.gitignore` rules and GitHub workspaces (ZIP), activation, the local app API server, progress, then the brain,
routes and launcher.

**PDF reading (owner's choice): Stellan's own reader**, not PDFium or PDF.js. `src/pdf.cpp` scans for objects,
unpacks object streams, walks the page tree and follows text operators with ToUnicode maps or the standard
encodings; Flate, ASCII85, ASCIIHex and LZW are supported. On 20 real documents (LibreOffice and ReportLab PDFs,
the stick's own leaflets, Word files) it matched PDF.js word for word on all but one, which it read better (an
activation code PDF.js split into letters). Encrypted PDFs are refused with the usual "unlock it first" message,
including ones PDF.js could open with an empty password; that is the known difference.

## Why it can't move one action at a time

`web.ts` keeps one shared state ("the brain"): phase (choose, loading, ready, error), the running task and its
cancel handle, pending approvals, warm-up and resting, context usage per model, the event list and the long-poll
waiters behind `/api/state?wait=`. Nearly every route reads or changes it, so moving routes piecemeal would leave
Host and Node disagreeing. The brain moves first, then the routes around it.

## Order

1. **Contract first (done).** `tests/window-contract.test.ts` plays scripted sessions over HTTP only (guards, the
   empty window, long-poll wake-up, a task with an approval the user refuses, cancelling a task) against a fake
   model server, and records each as a transcript with run-to-run noise removed. Two Node runs must give identical
   transcripts and identical model requests; with `STICK_TEST_WINDOW_HOST=<stellan-host>`, Host's
   `--window ROOT --test-model URL --test-model-key KEY` must give exactly the same. New scenarios are added as
   each step moves more routes.
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
