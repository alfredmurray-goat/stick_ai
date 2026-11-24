# MCP servers and skills

Open the coding workspace, then use **MCP servers** or **Skills** in the sidebar.
These features work in Lite and Lite + Max sessions. Direct Max mode generates
code and can apply an explicitly invoked skill, but does not call tools.

## Web search (built in)

Stick AI comes with [Actuent](https://actuent.ai) built in as an MCP server
(`https://agents.actuent.ai/api/mcp`, Streamable HTTP, free tier, no key). It
appears first under **Settings → MCP** and is on by default.

- Lite gets two simple tools: `web_search` (plain-words query) and
  `read_web_page` (a full https URL). They call Actuent's `actuent_search` and
  `actuent_get_page`. The rest of Actuent's tools (events, nearby places,
  compare, and more) are available through `mcp_tools` and `mcp_call` with the
  server ID `actuent`.
- **Every search asks first.** The approval card shows exactly the words or the
  address that will be sent. Nothing else leaves the computer: not your code,
  files or conversation.
- It connects on first use, so starting offline shows no error. Offline, a search
  says that web search needs the internet and Lite carries on without it.
- Results are trimmed to names, links, snippets, prices and page text (about
  6 KB at most; a typical search is under 1 KB) before Lite reads them, because
  a laptop CPU reads long prompts slowly.
- **Turn web search off** with the button on its card. The choice is saved in
  `logs/extensions/mcp.json` (`"webSearch": false`). Removing the server does
  the same thing.
- Actuent's index is strongest for places, products, prices and events. For
  programming questions, reading a specific docs page works better than a
  broad search.

While **Allow internet** is off (Settings → Models), web search is unavailable and Stellan is told so.

## MCP

While **Allow internet** is off, MCP servers on other computers can't be used. Servers that run on this computer (a command, or an address on `127.0.0.1`/`localhost`) keep working.

Add a named local **stdio** program, **Streamable HTTP** endpoint, or legacy
**SSE** endpoint. Remote endpoints require HTTPS; localhost HTTP is supported.
Enter argument lists as JSON arrays. `node` uses the bundled Node runtime;
`${project}` and `${app}` in arguments refer to the current project and app folder.
Other executables, such as Python, uvx and npx, must already be installed.
Programs run with your account permissions; connect only programs you trust.

For remote services, enter a bearer token or a JSON map of authentication headers.
For local servers, enter a JSON map of environment values. Header/environment
secrets stay in memory for the app session and are excluded from saved settings.
Re-enter them after quitting. OAuth-only services need a provider-issued access
token; browser OAuth sign-in is not implemented.

**Save & connect** starts a connection; **Save only** stores public configuration.
**Import project .mcp.json** reads Claude-style `mcpServers` configuration from
the current workspace. You can also paste JSON. Imported servers stay disconnected
until you review and connect each one. Environment-variable references in imported
configuration are not expanded automatically. Avoid putting credentials in saved
URLs, executable arguments or names; use the session secret fields instead.

Lite discovers connected servers with `mcp_tools` and invokes their listed tools
with `mcp_call`. Every invocation shows the server, tool and arguments and waits
for approval. Results and progress appear in live activity. Tools use the server's
own permissions, which can extend outside the project or contact external services.
Denied calls do not reach the server. Sampling and elicitation are not enabled.
The model currently receives text and structured results; images/audio are indicated
but are not sent to this text model.

There is no tool-call count limit or active-request deadline. **Stop** cancels work
and closes an outstanding MCP connection; reconnect it before trying again. Use
**Cancel connection** for a connection that is waiting. Quitting closes all servers.
Local servers disconnect when switching projects so their working directory cannot
silently point at a different repository. Saved servers do not auto-start on launch.

## Skills

Built-in commands include `/review-code`, `/fix-bug`, and `/plan-feature`.
Type `/` or choose **/ Skills** for commands. Add task details after the name.
Create a skill in settings, or import a `SKILL.md` file into the editor, review it,
then choose **Save & enable**. `$ARGUMENTS` is replaced with the command's task text.

The app also discovers packs at:

- `<project>/.claude/skills/<name>/SKILL.md`
- `<project>/.agents/skills/<name>/SKILL.md`
- The same directories under your home folder.

Project and user packs start disabled. Review their instructions and explicitly
enable them. Changes to the main SKILL.md disable that pack until reviewed again.
Skills may include relative supporting text files that Lite reads with `use_skill`;
these files remain untrusted project data and cannot escape the skill directory.
Only the main SKILL.md content is pinned by the review digest.

Example:

```markdown
---
name: review-api
description: Review API endpoints against our project conventions
---
Read the relevant handlers and supporting references.md.
Review $ARGUMENTS and report concrete issues with file evidence.
```

YAML `disable-model-invocation: true` requires an explicit slash invocation.
`user-invocable: false` hides the slash command while allowing model discovery.
Shell preprocessing, automatic scripts, forked subagents and permission overrides
from other applications are not executed. Skill instructions never grant permissions
or bypass file/MCP approvals. There is no claim of full Claude feature parity.

Public MCP configuration, app-created skill packs and skill preferences live under
`logs/extensions/` on the stick. App updates preserve this directory along with
models, linked Max paths and project files. MCP credentials must be re-entered
after quitting even when configuration is preserved.


The protocol client bounds both outstanding requests and unfinished transport writes to 64. A response arriving before its write finishes does not release that write's reservation in the shared 4 MiB outgoing budget. This keeps slow transports bounded even when responses arrive early.


## Stellan-Link

Stellan-Link is our tool-only MCP client: wire validation, initialization, RPC lifecycle, stdio processes, streamable HTTP, legacy SSE and tool-result validation use original implementations. The MCP SDK is retained only as a development-time test oracle; it is not imported into production. Human approvals, credential redaction, same-origin requests and message/queue budgets remain enforced. Interrupted resumable HTTP streams reconnect using event cursors without replaying the tool POST; failures without a cursor require an explicit reconnect. Legacy SSE disconnects also require reconnecting. OAuth authorization flows, resources/prompts subscriptions, sampling, elicitation and task execution are not advertised capabilities.

Reference: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports and https://modelcontextprotocol.io/specification/2025-11-25/server/tools . A local minified launcher comparison measured477,076bytes before and328,427bytes after, with11 SDK source modules before and0 after. This is a bundle-size result, not a runtime RAM/CPU/latency benchmark or universal MCP compliance claim.


LF-only SSE streams now reuse incoming byte buffers and one fatal UTF-8 decoder; CR/CRLF streams retain normalization. Production HTTP uses the transport's own JSON/event budgets and same-origin/redirect checks, avoiding a duplicate per-byte fetch transform. A five-pair synthetic parser diagnostic measured101.32ms to62.86ms median wall and122.93ms to85.73ms CPU for40x256KiB events in64byte fragments. RSS was essentially unchanged. This is framing work only, not app or model latency. [Raw receipt](benchmarks/stellan-link-sse.json).
