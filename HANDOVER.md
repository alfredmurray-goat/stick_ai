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

### In flight

- **Release for #27.** Desktop builds run [44284459765](https://github.com/alfredmurray-goat/stick_ai/actions/runs/44284459765) builds all four platforms. If it passes, it publishes the desktop release (`desktop-44284459765`) and the Mac DMGs. Check that every expected asset is there, including the four `stick_ai-<platform>-model-free` files.
- **Benchmarks.** Full HumanEval (164 problems) for Lite and Max, and six agentic tasks run through the real app for Lite and for Lite + Max. Lite's 21-problem sample scored 17/21 (81%). The README's Benchmarks section is waiting for the full figures.

## Known issues

- **Metal hasn't been checked on a real Apple Silicon Mac.** CI builds the Metal server, but GitHub's Macs are virtual machines whose paravirtual GPU was so slow that the Lite smoke test timed out, so virtual Macs now stay on the CPU and CI can't exercise Metal. Speed and memory on real M-series Macs (especially 8 GB) still need checking.
- **The Lite → Max handoff is slow.** Paired mode unloads Lite, loads Max, then reloads Lite, which loses Lite's prompt cache, so the conversation is read again from the start. llama.cpp's slot save/restore doesn't keep context checkpoints for Mamba2, so it won't fix this as is.
- **Max can't share memory with Lite.** Only one model runs at a time by design; Max needs 16 GB, and on 16 GB Macs it stays on the CPU because macOS caps GPU memory at about two thirds of RAM.
- **Max barely fits in 16 GB.** On a 16 GB Linux machine (4 cores), Max loaded and read prompts at ~7 tokens/s, but generating kept re-reading the 14.3 GB GGUF from disk (~240 MB/s of reads): the weights plus everything else don't fit in RAM, so pages are evicted every token. Max is only practical with more than 16 GB, or on Apple Silicon with Metal. Measure before promising Max on 16 GB machines.
- **Slow prompts and Node's fetch.** Node's fetch drops a response that's silent for 300 s. The app now asks the bundled server for `return_progress`, so long prompts stream progress chunks instead of going silent.
- **App updates come from Cloudflare R2, not GitHub.** Releases are private drafts, so sold sticks check `https://updates.localilabs.com/stick-ai/stick_ai-updates.json` (see [docs/UPDATES.md](docs/UPDATES.md)). Nothing reaches sticks until the owner creates the R2 bucket and custom domain and adds the four `R2_*` secrets. Older releases published before the drafts change are still public until they're deleted or set back to drafts on GitHub.
- **The all-devices stick is new.** One stick now carries the Mac (universal), Windows and Linux apps at its top level, sharing one `Stellan` folder (manifest, app, runtimes and one copy of each model). The desktop app finds `Stellan/manifest.json` beside it; updates replace the apps beside `Stellan` too (`src/portable/universal.ts`, `scripts/publish-stick.mjs`, `docs/STICKS.md`). The universal Mac app is merged with `lipo` and ad-hoc signed on CI. Test a real stick on an Apple Silicon Mac, an Intel Mac, Windows and Linux before selling.
- **Lite's chat template is unverified.** The GGUF has none, so the app uses a tested Mistral-v1 formatter.
- **A stale draft release** (`desktop-42818788142`, untagged) is left over from an earlier failed publish. It isn't visible publicly; delete it when convenient.
- **Builds are unsigned.** Gatekeeper and SmartScreen prompts on first launch are expected.

## Next steps, in order

1. Confirm the #27 release published every asset, then download the Linux model-free archive and run a real task with a linked Lite.
2. Put the full HumanEval and agentic results in the README and the release notes.
3. Run Lite on a real Apple Silicon Mac (8 GB and 16 GB) and record tokens per second with Metal and with `STICK_GPU=0`.
4. Speed up the Lite → Max handoff, for example by keeping Lite loaded when RAM allows, or by skipping the Lite reload until it's needed.
5. Add syntax highlighting to code blocks in answers. It has to be built in, because the CSP blocks external libraries.
6. Sign and notarise the Mac builds, and sign the Windows build.

## Useful facts

- **How a release happens:** see [AGENTS.md → Releases](AGENTS.md#releases).
- **Pinned versions:** llama.cpp `cd959bae99ff4bed22bef2604f45241c09bbb8c8` (`llamaRelease` v0.9.0), Node.js 24.22.1, Lite GGUF sha256 `84328c45…`, Max GGUF sha256 `05f00035…` (see `src/portable/max-release.ts`).
- **Lite server settings** (`modelRuntimeArgs` in `src/portable/engine.ts`): one slot, 512/256 batches, prompt cache on, one context checkpoint, no cross-conversation RAM cache. Peak memory on the release Lite is about 4.5 GB.
- **Where model files are found:** a linked file in `logs/lite-model.json` or `logs/max-model.json` wins over a bundled file in `models/`.
