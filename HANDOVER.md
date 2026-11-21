# Handover

The state of Stick AI as of **18 November 2026**, for whoever picks it up next. Update this file when you finish a piece of work or leave something half-done.

## Where things stand

Stick AI is a private, offline coding assistant: a Tauri desktop app around a local web workspace, an agent loop, and a bundled llama.cpp server running Stellan-1 Lite (Mamba2, about 4.1 GB) and Stellan-1 Max (about 14.3 GB). It ships for Apple Silicon Mac, Intel Mac, Windows x64 and Linux x64.

### Recently merged

| PR | What changed |
| --- | --- |
| [#25](https://github.com/alfredmurray-goat/stick_ai/pull/25) | Workspace UI redesign: formatted Markdown answers, before/after diffs in approvals, tool timeline, SVG icons, light and dark themes. |
| [#26](https://github.com/alfredmurray-goat/stick_ai/pull/26) | Lite keeps its prompt cache between agent steps. A follow-up step went from ~95 s to ~5 s on a 4-core CPU; a real two-message task from 850 s to 421 s. |
| [#27](https://github.com/alfredmurray-goat/stick_ai/pull/27) | Model-free downloads for all four platforms (link your own Lite and Max GGUFs), Apple Silicon GPU (Metal) with automatic CPU fallback, and the llama.cpp web-UI build fix. |
| [#28](https://github.com/alfredmurray-goat/stick_ai/pull/28) | README restyled with screenshots, features and benchmarks. |

- **Web search built in.** Actuent (`https://agents.actuent.ai/api/mcp`) is a built-in MCP server, on by default and connected on first use. Lite has `web_search` and `read_web_page`; results are trimmed by `src/portable/web-search.ts`. Every search is approved. The setting is `webSearch` in `logs/extensions/mcp.json`. Tested live against Actuent on 2026-11-19.

- **Lighter and faster (2026-11-20).** The system message is now the same for a whole session: the file list, named files and skill guidance go with each task (`taskMessage`). Lite pre-reads the system message in the background right after it starts (`ManagedEngine.warm`) and saves it, so **New conversation** reloads it in ~0.25 s. On 4 CPU cores the first reply read 75 new tokens instead of 1,721 (60 s instead of 116 s). The window long-polls `/api/state` (1 request per 10 s when idle instead of 20). The model rests after 10 quiet minutes (`STICK_REST_MINUTES`) and wakes with the conversation restored. Thinking and tool steps now stream inline in the conversation and fold into "Thought for N s · N steps".

- **Hooks (2026-11-20).** Claude Code-style hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`) in Settings → Hooks, saved in `logs/extensions/hooks.json`. A hook either runs a command (event JSON on stdin; exit 2 or `{"decision":"block"}` blocks) or POSTs to a local app. They are the planned way for a notch-voice companion to follow Stellan: it listens on localhost and gets `Notification` and `Stop` events. See docs/HOOKS.md.

- **Harness upgrade (2026-11-21).** Context windows sized by `contextPlan` (Lite 65k, Max 8k/16k/32k by RAM; Long context mode in Settings → Models: Lite 262k, Max up to 65k, history budget ~100k tokens). Smart compaction (`compactHistory`) summarises older tasks at the start of a new task. Max runs with `--flash-attn on`, an 8-bit KV cache and `--spec-type ngram-simple` (2.9× faster rewrites, identical output), and falls back without them if a build refuses (`plainFallback`). `run_shell` now works in the app with a "Run this command?" approval card (sandboxed on Mac/Linux, warned on Windows).

### In flight

- **Releases.** Each main build publishes one private draft, `stick-<run>` ("Stick AI — all devices — build N"), with `stick_ai-all-devices.zip` and the signed updates, and uploads the updates to Cloudflare R2. There is no way to publish a public release; the old Mac DMG workflows were removed.
- **Benchmarks.** Lite scored 120/164 (73.2%) on the full HumanEval (in the README). Max and the agentic tasks still need a machine with more than 16 GB of memory (see Known issues).

## Known issues

- **Metal hasn't been checked on a real Apple Silicon Mac.** CI builds the Metal server, but GitHub's Macs are virtual machines whose paravirtual GPU was so slow that the Lite smoke test timed out, so virtual Macs now stay on the CPU and CI can't exercise Metal. Speed and memory on real M-series Macs (especially 8 GB) still need checking.
- **The Lite → Max handoff reloads both models below 32 GB.** From 30 GiB reported (46 GiB on a Mac using the GPU), Max stays loaded beside Lite after its first job (`keepsBothLoaded`, `ManagedEngine.coder`), so later handoffs are instant; not yet measured on a real 32 GB machine. Below that only one fits in memory, so Max replaces Lite while it writes code (loading each takes time on a USB stick). Lite's prompt cache is now saved to the computer's temp folder before the swap (`/slots/0?action=save`, `--slot-save-path`) and restored afterwards, so Lite doesn't re-read the conversation: measured 48 tokens and 3 s instead of 2,020 tokens and 81 s, with save/restore ~0.25 s each and a ~0.55 GB file deleted after restore. If saving fails, the swap works as before.
- **Max can't share memory with Lite.** Only one model runs at a time by design; Max can be chosen from 16 GB (15 GiB reported) with a slowness warning and is only used automatically from 24 GB (22 GiB reported), and Macs below 24 GiB keep it on the CPU because macOS caps GPU memory at about two thirds of RAM.
- **Max is very slow in 16 GB, so the app warns before using it there and only pairs it with Lite from 24 GB.** Retested on 2026-11-20: no answer to a one-line prompt after 20+ minutes, 272 GB re-read from disk. On a 16 GB Linux machine (4 cores), Max loaded and read prompts at ~7 tokens/s, but generating kept re-reading the 14.3 GB GGUF from disk (~240 MB/s of reads): the weights plus everything else don't fit in RAM, so pages are evicted every token. Max is only practical with more than 16 GB, or on Apple Silicon with Metal. Measure before promising Max on 16 GB machines.
- **Slow prompts and Node's fetch.** Node's fetch drops a response that's silent for 300 s. The app now asks the bundled server for `return_progress`, so long prompts stream progress chunks instead of going silent.
- **App updates come from Cloudflare R2, not GitHub.** Releases are private drafts, so sold sticks check `https://updates.localilabs.com/stick-ai/stick_ai-updates.json` (see [docs/UPDATES.md](docs/UPDATES.md)). Nothing reaches sticks until the owner creates the R2 bucket and custom domain and adds the `CLOUDFLARE_API_TOKEN` secret and `R2_ACCOUNT_ID` variable. Older releases published before the drafts change are still public until they're deleted or set back to drafts on GitHub.
- **The all-devices stick is new.** One stick now carries the Mac (universal), Windows and Linux apps at its top level, sharing one `stellan` folder (manifest, app, runtimes and one copy of each model). The desktop app finds `stellan/manifest.json` beside it; updates replace the apps beside `stellan` too (`src/portable/universal.ts`, `scripts/publish-stick.mjs`, `docs/STICKS.md`). The universal Mac app is merged with `lipo` and ad-hoc signed on CI. Test a real stick on an Apple Silicon Mac, an Intel Mac, Windows and Linux before selling.
- **Releases carry no models.** `stick_ai-all-devices.zip` is the apps plus `stellan/` without models; the owner keeps the official GGUFs in each stick's `stellan/models`. The first start hashes them once (1–3 minutes from USB); later starts trust size + modification time (`logs/verified-models.json`). The app icons are upscaled from a ~450 px source image; replace them with a vector or 2048 px original when one exists.
- **Lite's chat template is unverified.** The GGUF has none, so the app uses a tested Mistral-v1 formatter.
- **A stale draft release** (`desktop-42818788142`, untagged) is left over from an earlier failed publish. It isn't visible publicly; delete it when convenient.
- **Builds are unsigned.** Gatekeeper and SmartScreen prompts on first launch are expected.

## Next steps, in order

1. Confirm the #27 release published every asset, then download the Linux model-free archive and run a real task with a linked Lite.
2. Measure Max on HumanEval and run the agentic tasks on a machine with more than 16 GB of memory, then add them to the README (Lite's full HumanEval result is already there).
3. Run Lite on a real Apple Silicon Mac (8 GB and 16 GB) and record tokens per second with Metal and with `STICK_GPU=0`.
4. Measure keeping Lite and Max both loaded on a real 32 GB computer (memory and handoff time), and lower or raise the 30 GiB threshold to match.
6. Sign and notarise the Mac builds, and sign the Windows build.

## Useful facts

- **How a release happens:** see [AGENTS.md → Releases](AGENTS.md#releases).
- **Pinned versions:** llama.cpp `cd959bae99ff4bed22bef2604f45241c09bbb8c8` (`llamaRelease` v0.9.0), Node.js 24.22.1, Lite GGUF sha256 `84328c45…`, Max GGUF sha256 `05f00035…` (see `src/portable/max-release.ts`).
- **Lite server settings** (`modelRuntimeArgs` in `src/portable/engine.ts`): one slot, 512/256 batches, prompt cache on, one context checkpoint, no cross-conversation RAM cache. Peak memory on the release Lite is about 4.5 GB.
- **Where model files are found:** a linked file in `logs/lite-model.json` or `logs/max-model.json` wins over a bundled file in `models/`.
