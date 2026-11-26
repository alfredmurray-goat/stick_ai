# Stellan-Link: our MCP client

Stellan-Link is the app's own MCP (Model Context Protocol) client: the part that starts MCP servers, talks to them and passes approved tool calls through. As of 25 November 2026 it runs with **no third-party MCP code at all**:

| Piece | File | Notes |
| --- | --- | --- |
| Message checking | `mcp-wire.ts` | Validates every JSON-RPC message: IDs, envelopes, nesting, size |
| Start-up handshake | `mcp-handshake.ts` | Checks protocol version, server identity and tool support |
| Requests and replies | `mcp-rpc.ts` | Bounded in-flight work, cancellation, shutdown |
| Tool results | `mcp-results.ts` | Validates tool results before Stellan sees them |
| Local servers (stdio) | `mcp-process.ts`, `mcp-stdio-entry.ts`, `mcp-lines.ts` | Own process group, bounded line framing, strict UTF-8 |
| Remote servers (HTTP) | `mcp-http.ts` | Streamable HTTP with the same limits |
| Starting programs | `spawn-command.ts` | Replaces `cross-spawn` (below) |

The official `@modelcontextprotocol/sdk` is now only a **development** dependency: tests cross-check our validators against its schemas, and it is not shipped in the app. Supported protocol versions are explicit constants, checked against the pinned SDK in tests, so upgrades are a deliberate decision.

## Link in Host

In packages that ship Stellan-Host, Host now speaks MCP to local (stdio) servers itself: `stellan-host --mcp-client`
starts the program in its own process group (POSIX) or job object (Windows), frames and checks every message with the
same rules as `mcp-wire.ts`, `mcp-handshake.ts` and `mcp-results.ts` (`src/mcp_wire.cpp`), answers pings, keeps the same
64-request and 4 MiB in-flight limits, and matches replies (`src/mcp_client.cpp`). The app talks to it through
`HostMcpRpc` (`src/portable/mcp-host-rpc.ts`), which has McpRpc's interface, so approvals, hooks and catalog limits
are unchanged. `tests/mcp-wire-native.test.ts` compares the checks on 4,000 generated messages and
`tests/mcp-host-client.test.ts` runs the same session against both clients. Remote (HTTP) servers, including
Actuent web search, keep the app's Streamable HTTP logic but go online through Host's HTTPS (`appFetch`), which passes
event streams through as they arrive (`tests/mcp-http-host.test.ts`).

## Native MCP bridge (Stellan-Host, all platforms)

Each local (stdio) MCP server used to run under its own **Node bridge process (about 47.5 MB each)**, which gave the program its own process group and cleaned up after it. In packages that ship Stellan-Host, every platform now uses **`stellan-host --mcp-bridge` instead: about 3.5 MB**, measured on the same machine. The program inherits the app's pipes directly, so no bytes are copied through the bridge; a fourth pipe is the app's "lifeline", and when the app closes it (or exits) the bridge ends the program and everything it started. When the program exits, its leftover descendants are ended too. Host is checked against the package manifest's SHA-256 before its first use. On Windows the bridge runs the program inside a **job object** that ends with the bridge, the program or the lifeline; the app resolves the program through PATH/PATHEXT (never the project folder) and passes the exact command line, with the same batch-file escaping it uses itself. A program that cannot be resolved keeps the Node bridge, as before. Tests: `tests/mcp-bridge.test.mjs` (real processes, in CTest) and `tests/mcp-native-bridge.test.ts` (the app's MCP manager connecting through Host).

## Starting MCP programs safely (`spawn-command.ts`)

On macOS and Linux an MCP program is started directly, with no shell. On Windows, commands like `npx` are batch files (`npx.cmd`), which Node won't start directly (CVE-2024-27980). Stellan-Link therefore:

- finds the program through `PATH` and `PATHEXT` and **never searches the project folder**, so a project can't plant a fake `npx.cmd`;
- starts `.exe` programs directly;
- runs `.cmd`/`.bat` files through `cmd.exe /d /s /c` with every argument quoted the way Windows programs read it back, then escaped with carets **twice**. Batch shims such as `npx.cmd` hand their arguments to `cmd.exe` a second time, so one round of escaping isn't enough: an argument holding a quote could end the quoting early and let a later `&` run a command. The `cross-spawn` package only added the second round for `node_modules\.bin` shims.

`tests/spawn-command.test.ts` checks the quoting rules everywhere and, on Windows CI, runs a real `.cmd` file with spaces, quotes, `&`, `|`, `%PATH%`, carets, parentheses, `!` and an empty argument, checking every one arrives unchanged and nothing runs.

## Original initialization core

`mcp-handshake.ts` now validates the initialization fields our tool-only client uses and projects them into a small original result type. It verifies the selected protocol string, server identity, tool capability and optional list-change flag. Unsupported versions and servers without tools still close the connection. Unused capabilities/instructions are not enabled or forwarded to the model; this is a bounded tool-client contract rather than full SDK schema parity. Supported version constants are explicit and checked against the pinned SDK in tests, so upgrades require a deliberate decision.

The RPC lifecycle and its wire/initialization helpers bundle without a runtime SDK or schema-library implementation. At the initialization checkpoint, before the later in-flight guards, an isolated minified RPC bundle measured **115,293 → 5,204 bytes**; five alternating fresh Node 24.22.1 imports measured median import CPU **18.089 → 0.595 ms**, with median process RSS about **63.7 → 58.2 MB**. These historical component-only measurements are not whole-app savings or a size measurement of the later guarded core: at that time the remaining app imports still loaded SDK code; they no longer do. [Bundle receipt](mcp-rpc-bundle.json) and [raw import trials](mcp-rpc-import.json) retain the scope and limitations. No forced GC or model loading was used.

Tool discovery also now rejects any repeated pagination cursor, caps discovery at 1,000 pages and bounds the aggregate serialized tool/cursor payload to 4 MiB. This prevents an endless empty-catalog cycle and accumulation of many individually valid large pages. The byte limit is a serialized-payload budget, not an exact heap/RSS cap; tool calls retain their existing approval flow and do not gain an artificial execution deadline. Integration fixtures verify nonconsecutive cursor cycles and two individually permitted pages that exceed the aggregate budget.

## Bounded streaming and pending work

Our stdio transport now frames NDJSON in a geometrically grown buffer, copying each fragment once rather than copying its entire preceding message again. Complete lines in a single chunk are decoded directly. The 4 MiB line limit remains; buffers above 64 KiB are released after a complete line and partial input is released on close. UTF-8 decoding remains strict and split code points are assembled before decoding. RPC limits outstanding requests to 64 and their aggregate serialized outgoing payload to 4 MiB, releasing budgets after replies, send failures, cancellation and disconnection. This is an in-flight payload budget, not an exact heap cap. Existing calls are not given artificial deadlines; excess new work is rejected with a wait/reconnect message.

[Five alternating fresh-process trials](mcp-lines-bench.json) over eight synthetic 256 KiB lines measured median framing CPU 898.70 → 21.67 ms with 64-byte fragments, and 20.36 → 2.90 ms with 4 KiB fragments. Median peak process RSS was 159.4 → 71.6 MB and 130.5 → 63.7 MB respectively, including Node and allocator behavior. The new reader retained no large framing buffer afterward. These stress results isolate framing/copying; JSON parsing, RPC operations, SDK code, model inference and the complete app are excluded. They do not establish whole-app savings. Run `npm run build`, then `node scripts/bench-mcp-lines.mjs NEW_REPORT.json` to reproduce the diagnostic.

Connection shutdown also settles an unfinished transport start or initialization send. Abort listeners are removed on each settled step; a late startup completion cannot mark a closed connection ready. Stdio releases partial framing storage immediately on close and ignores later output. Existing tool approvals and absence of artificial execution deadlines are unchanged.

Server-initiated replies now share the 4 MiB outgoing budget with pending client requests and allow at most 16 concurrent writes. A flood of pings or oversized echoed request IDs closes the connection and settles waiting calls, rather than building an unbounded backpressure queue. Late messages after shutdown are ignored. Ordinary sequential pings remain supported, and settled replies release their budget. This bounds serialized payloads, not complete heap usage.
