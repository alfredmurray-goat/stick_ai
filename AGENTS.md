# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should start with [CONTRIBUTING.md](CONTRIBUTING.md). For the current state of the project and work in flight, read [HANDOVER.md](HANDOVER.md).

## Commands

```bash
npm install --ignore-scripts --no-audit --no-fund   # install dev tooling
npm run check                                       # strict TypeScript, no emit
npm test                                            # Vitest, the whole suite (~20 s)
npx vitest run tests/<file>.test.ts                 # one file
npm run build                                       # compile src/ to dist/
npm run licenses                                    # regenerate THIRD_PARTY_LICENSES.md (CI fails if it changes)
cd src-tauri && cargo check                         # native shell; Linux needs libwebkit2gtk-4.1-dev
```

Use Node.js 24.22.1 (`.nvmrc`). On other Node versions, `tests/portable-supervisor.test.ts` can fail for environment reasons; it passes in CI.

## Layout

| Path | What it is |
| --- | --- |
| `src/agent/` | Agent loop, context building, history trimming (`boundedToolHistory`), Max delegation |
| `src/model/` | Model client (`ollama.ts`, OpenAI-compatible streaming) and the tagged protocol parser |
| `src/tools/` | Tools the model can call, and their schemas |
| `src/sandbox/` | Safe path resolution and sandboxed shell execution per platform |
| `src/portable/` | Desktop/USB runtime: `layout.ts` (all-devices sticks keep the apps at the top and everything shared in `stellan/`, which is the "root" everywhere else), `universal.ts` (builds that stick), `web.ts` (local API + UI server), `engine.ts` (managed llama.cpp), `local-models.ts` (bundled or linked GGUFs), `integrity.ts`, `package.ts`, `update*.ts`, GitHub workspaces, MCP, skills |
| `src/cli/` | `stick` terminal assistant |
| `portable/ui/` | Workspace UI: `index.html`, `main.js`, `style.css`, no build step |
| `src-tauri/` | Rust desktop shell (Tauri 2): start/stop, native file chooser, updates |
| `scripts/` | Packaging, smoke tests, release publishing |
| `tests/` | Vitest suite |
| `docs/` | Guides and README images |
| `ollama/` | Modelfiles for terminal use with Ollama |

## Rules that must not be broken

- **Never commit model weights.** `.gguf` files are gitignored and downloaded with pinned SHA-256s by `scripts/fetch-platform-assets.mjs` and `scripts/assemble-full-release.mjs`.
- **The UI runs under a strict CSP** (`default-src 'none'; script-src 'self'; style-src 'self'`). No inline `<script>`, no `style="…"` attributes in HTML, no external URLs. Setting `element.style.x` from JS is allowed. Icons are an inline SVG sprite in `index.html`.
- **Never render model output with `innerHTML`.** `renderMarkdown` in `main.js` builds DOM nodes with `textContent`.
- **Keep every element ID that `main.js` uses** when editing `index.html`. `tests/portable-web.test.ts` also expects the text "Start chatting" in the page.
- **Every file in a package is in its manifest.** `verifyStick` rejects unlisted or changed files. Model files are marked `optional` so model-free downloads pass; a present model must still match its hash.
- **The prompt cache depends on stable prefixes.** Lite runs with `cache_prompt: true` and `--ctx-checkpoints 1`. Anything that rewrites earlier messages on every step (for example, trimming old tool output a little more each time) forces the server to reprocess the whole conversation. `boundedToolHistory` trims in steps of half the limit for this reason; `tests/responsive.test.ts` guards it. The system message must stay the same for the whole session: the project file list, named files and skill guidance go in the task message (`taskMessage`), because `ManagedEngine.warm` pre-reads the system message at start and **New conversation** restores that saved state; `tests/lighter.test.ts` guards it.
- **The window long-polls.** `/api/state?wait=<key>` is held until something changes (or 8 s). Don't go back to fixed-interval polling: an idle window should cost nothing. The model also rests after `STICK_REST_MINUTES` (default 10) quiet minutes.
- **GitHub sign-in tokens stay in memory.** `GitHubSignIn` (`src/portable/github-auth.ts`) keeps the device-flow token in the Node process only: never saved, logged, sent to the window or put in model context. Never add a client secret or the GitHub App's private key to the app.
- **Activation stays offline after the first start.** `Activation` (`src/portable/activation.ts`) checks a saved Ed25519 certificate against `activationPublicKey` at every start; only activating contacts the website. Never ship the private signing key (it lives in the website's database), and keep `activationPublicKey` empty in tests. See docs/ACTIVATION.md.
- **Approvals stay mandatory.** Writes, edits, shell commands and MCP calls go through the approval callbacks. Don't add bypasses. Hooks (`src/portable/hooks.ts`, docs/HOOKS.md) can block or add notes but never approve, and are only read from the app's own settings, never from a project folder.

## Releases

- Merging to `main` with changes under `src/`, `src-tauri/`, `portable/`, `package*.json` or the desktop workflows starts **Desktop builds** (`.github/workflows/desktop.yml`). Docs-only and tests-only changes don't: after merging one of those, start `desktop.yml` by hand on `main` if you need a release.
- Each platform job runs the tests, builds the native app and llama.cpp server, assembles the package and runs a **real Lite tool exchange** (`scripts/smoke-platform.mjs`) before uploading.
- **Releases stay private.** The publish scripts upload into a draft release and leave it as a draft, which only people with write access can see: the app is sold preinstalled on sticks. There is no switch to make them public, by the owner's choice. Sold sticks update from a private Cloudflare R2 host instead (`scripts/update-host.mjs`, `feed` in `app/update-config.json`; see `docs/UPDATES.md`): every successful build is uploaded there automatically once the `CLOUDFLARE_API_TOKEN` secret and `R2_ACCOUNT_ID` variable are set (the older four `R2_*` secrets also work).
- If all four platforms pass, the `macos-universal` job merges the two Mac apps with `lipo`, and the `publish` job starts `release.yml`. It runs `scripts/publish-stick.mjs`, which publishes **one** draft release per build: `stick_ai-all-devices.zip` (the apps and the `stellan` folder **without models**, plus install helpers that merge onto a stick without deleting `stellan/models`), checksums and the signed app updates, including the `universal` one. See `docs/STICKS.md`. The old Mac DMG workflows were removed.
- A new push to `main` cancels a Desktop build that's still running (`cancel-in-progress`). Don't merge app changes while a release build you want is running.
- To test the real builds without publishing, run `desktop.yml` by hand on your branch: the `publish` job only runs on `main`.
- The llama.cpp server is cached per platform. Change the cache key in `desktop-platform.yml` when you change its build flags.

## Speed

- **Model checks are remembered.** `verifyStick(..., remember = true)` (only the running app passes it) skips re-hashing a model whose size and modification time match its last full check, recorded in `logs/verified-models.json`. Hashing both models took one to three minutes from a USB stick on every start. Programs and app files are still hashed every time. Builds never pass `remember`.

## Traps found the hard way

- **Privileged ports.** CI runners aren't root, so a test that binds port 1 fails with `EACCES` on macOS and Linux but passes as root. Use ports above 1024.
- **Slow runners.** The Intel macOS runner is several times slower. Tests that package or archive need an explicit timeout (`it(..., 30000)`).
- **llama.cpp web UI assets.** At the pinned commit, a fresh server build downloads web UI assets that no longer match and fails. Builds pass `-DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_UI=OFF`; the app runs with `--no-webui`.
- **Apple Silicon runners are scarce.** A `macos-arm64` job can sit queued and be cancelled. Re-run it rather than changing code.
- **Metal on CI.** GitHub's macOS runners are virtual machines with a paravirtual Metal device that loads the model but runs it many times slower than the CPU: the Lite smoke test went from about 5 to over 30 minutes and timed out. The engine therefore skips the GPU on virtual Macs (`kern.hv_vmm_present`), so CI only proves the Metal server builds. Check Metal itself on a real Apple Silicon Mac.
- **`origin` branches after a squash merge.** The working branch can hold already-merged commits. Merge `origin/<branch>` into the new work instead of force-pushing, then check the diff against `main` is only your change.

## Style

- Strict TypeScript, ESM. Comments only explain why.
- Keep user-facing text plain and friendly. Error messages say what to do next.
- Update `README.md` and the relevant guide in `docs/` when behaviour changes, and the screenshots in `docs/` when the UI changes.
