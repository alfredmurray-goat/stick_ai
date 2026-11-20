# Hooks

Hooks let Stick AI run your own command, or tell another app on your computer, when something happens. They work like [Claude Code's hooks](https://code.claude.com/docs/en/hooks): same event names, same JSON and the same way of saying "stop".

Add them in the app under **Hooks** in the sidebar (or **Settings → Hooks**). Use **Test** to try one with a sample event.

## When hooks run

| In the app | Event name | Can it stop things? |
| --- | --- | --- |
| When a conversation starts | `SessionStart` | No. Its output is passed to Stellan with your first message. |
| When you send a message | `UserPromptSubmit` | Yes: the message never reaches Stellan, and the app shows the reason. Output adds notes for Stellan. |
| Before Stellan uses a tool | `PreToolUse` | Yes: the tool doesn't run, and Stellan is told why. |
| After Stellan uses a tool | `PostToolUse` | Its reason or output is added to the tool's result as feedback for Stellan. |
| When Stellan needs your approval | `Notification` | No. |
| When Stellan finishes | `Stop` | No. |

Tool hooks can be limited to some tools with a filter, for example `edit_file` or `write_file|edit_file`. Leave it empty, or use `*`, for every tool. Tool names: `list_dir`, `read_file`, `write_file`, `edit_file`, `search_files`, `delegate_code`, `web_search`, `read_web_page`, `mcp_tools`, `mcp_call`, `use_skill`.

**A hook can never approve anything.** File changes, web searches and MCP calls still wait for you in the app. A `PreToolUse` hook runs before the approval card, so it can stop a change before you're asked.

## Two kinds of hook

- **Run a command.** The command runs in your project folder with `/bin/sh` (Mac and Linux) or `cmd.exe` (Windows). The event arrives as JSON on standard input, and `STICK_PROJECT_DIR` and `STICK_HOOK_EVENT` are set.
- **Notify an app on this computer.** Stick AI sends the event as a JSON `POST` to an address such as `http://127.0.0.1:8765/stick`. Only HTTPS, or plain HTTP to `127.0.0.1`/`localhost`, is allowed. This is how a companion app (for example a voice assistant) can follow along.

Each hook has a time limit (30 s by default, up to 600 s). A hook that runs too long is stopped, and the app shows a short message.

## What a hook receives

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "6f1c…",
  "cwd": "/Volumes/STICK/stellan/app/project",
  "tool_name": "edit_file",
  "tool_input": { "path": "src/app.ts", "old": "…", "new": "…" }
}
```

Other fields by event:

| Event | Fields |
| --- | --- |
| `UserPromptSubmit` | `prompt` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` |
| `Notification` | `notification_type`, `message` |
| `Stop` | `status` (`finished`, `failed` or `cancelled`), `prompt`, `last_assistant_message` |
| `SessionStart` | `source` (`startup`, `clear` or `project`) |

## What a hook can reply

- **Exit code 0** (or HTTP 2xx): it's fine. Any text written to standard output (or the response body) becomes notes for Stellan.
- **Exit code 2**: stop. The text on standard error is the reason.
- **JSON reply** on standard output or in the response body:
  - `{"decision": "block", "reason": "…"}` stops it.
  - `{"additionalContext": "…"}` adds notes for Stellan.
- **Any other exit code**, or an HTTP error: the hook failed. The work carries on, and the app shows a short message.

## Examples

Say something when Stellan finishes (Mac):

```
say "Stellan is done"
```

Keep Stellan away from secrets (a `PreToolUse` hook with the filter `read_file|edit_file|write_file`). It uses Node.js, which you'd need installed on the computer:

```
node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).tool_input.path||'';if(/(^|\/)\.env/.test(p)){console.error('Stellan may not open .env files');process.exit(2)}})"
```

## Safety

- **Your settings only.** Hooks are added by you in the app and saved in `stellan/logs/extensions/hooks.json` on the stick. They are never read from a project folder, so opening someone else's project can't make Stick AI run anything.
- **Your permissions.** Commands run with your permissions, like any program you start yourself. Only add commands you trust.
- **No more than 50 hooks.**
