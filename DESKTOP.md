# Desktop app

Tauri is used because it can reuse the existing local web UI through the operating system's webview, without shipping a second browser engine. That keeps the wrapper small for machines with 8 GB of RAM. Rust owns the hidden Node service, which owns the local model process; the buyer never uses a terminal. Tauri is MIT OR Apache-2.0, and the stick_ai code remains MIT. No npm dependency was added.

## What the buyer sees

Open the desktop folder for the computer and double-click the app. The first screen says “Your private AI assistant. Everything runs on this computer.” and has one Start button. Start verifies the release files, checks RAM, starts Lite and waits for authenticated server readiness before opening chat in the same window. Unsupported systems and model errors are shown as a sentence with one action. Max is unavailable below 16 GiB and the portable app requires at least 8 GiB. At 16 GiB with both models present, Lite can delegate to Max; only one model process is owned at a time.

The chat has an animated progress indicator, Cancel and a collapsed Show thinking panel. Thought text updates while collapsed; opening the panel shows it dimmed. Code from Max streams into a separate collapsible preview while Lite remains responsible for applying approved changes. Ctrl+C cancels a current step. The chat cannot use the internet or run programs; its file tools operate in app/project on the stick.

Health and optional slot information select “Reading your project...” or “Thinking...”; missing slot support falls back to the application phase. Elapsed seconds appear after ten seconds. After sixty seconds without visible output, the reassurance says “Still working. Large models on this computer can take a few minutes.” These are activity indicators, not fabricated percentage estimates.

## Inactivity and context settings

Model requests, shell commands and model loading have no application execution or inactivity deadline. `STICK_IDLE_TIMEOUT_SECONDS` is no longer used. Cancel stops a request or model load; quitting stops the owned service and model processes. Health probes retain short retry deadlines, and shutdown cleanup remains bounded. Delegation has no call cap, while the configured agent step limit still applies. A silent or loading model waits until it responds, fails or is cancelled.

`STICK_CONTEXT_MAX_BYTES` defaults to 16384, with a range of 256 through 1048576. Automatic context includes a bounded file list and contents of files explicitly named in the task, including unique basenames; ambiguous basenames do not trigger content reads. File tools can fetch further relevant files deliberately. Tool history sent to the model is also bounded; the application's retained conversation is not overwritten. The setting limits automatic context, not the total system prompt, typed task or model tokenizer's token count.

The optional faster setting selects Lite, disables Max swaps and reduces the server context to 4096 and automatic context to 4096 bytes. It reloads Lite as necessary. Silent requests no longer trigger automatic inactivity errors or faster-setting suggestions. This does not guarantee a particular first-token time.

## Build for release

The native build needs Rust, Tauri CLI 2.12.2 and the platform prerequisites documented at https://v2.tauri.app/start/prerequisites/ . The TypeScript runtime remains Node.js 24.22.1. The source archive contains no ready-to-run desktop binaries, llama-server executables, Node runtimes or model weights.

```sh
npm install
npm run check
npm test
npm run build
cargo install tauri-cli --version 2.12.2 --locked
cargo tauri build
node scripts/native-licenses.mjs dist/desktop-licenses
npm run licenses
```

Build macOS arm64 and x64 on macOS, Windows x64 on Windows and Linux x64 on the supported Linux baseline. Use `--target aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc` or `x86_64-unknown-linux-gnu` as appropriate. Preserve the generated Cargo.lock with each release and review the resolved transitive licences; native-licenses.mjs refuses missing upstream licence text. Collect the notices from all four native builds into one audited directory. The committed Cargo.lock was obtained from the actual successful Intel native compilation.

The native CI matrix compiles the application and uploads unsigned build artifacts and Cargo.lock. Mac jobs produce .app bundles; other jobs produce executables. Those artifacts are intermediate release inputs, not complete sticks. CI configuration is provided but no hosted run is claimed here. Signing, notarization, Windows reputation and Linux system-library qualification remain release work. A missing system webview cannot be repaired without installing it: Windows needs WebView2 and Linux needs compatible WebKitGTK; unsupported clean machines need an OS update or the technical browser fallback. No automatic runtime installer or network updater is included.

Supply the existing build:stick arguments described in PORTABLE.md plus all of these required desktop arguments:

```sh
--desktop-macos-arm64 /assets/macos-arm64/StickAI.app
--desktop-macos-x64 /assets/macos-x64/StickAI.app
--desktop-windows-x64 /assets/windows-x64/stick-ai.exe
--desktop-linux-x64 /assets/linux-x64/stick-ai
--desktop-licenses /assets/desktop-licenses
```

The builder preserves .app contents and timestamps, checks main-executable architecture and hashes all desktop files. Sign the native app and nested native components before assembling the final manifest; do not modify signed contents afterward. The builder rejects links in the final static tree. Ensure any required portable runtime sidecars are supplied and licensed. The release command requires all four desktop inputs and notices; the low-level builder's optional desktop field remains for legacy fixture and technical builds.

## Lifecycle and privacy

The native bootstrap verifies the bundled Node and JavaScript bundle before execution. The Node service verifies all manifest static hashes before model execution. All model and UI listeners bind to 127.0.0.1; occupied model ports are skipped, never trusted. Health, authenticated model alias, invalid-key rejection and owned-process liveness checks still apply. The webview allows navigation only to its bundled welcome page or the verified service origin. Remote pages have no native command authority. These are corruption checks relative to a trusted manifest, not a substitute for a signed distribution.

The native app writes technical logs to the operating system's application log folder using Tauri's app_log_dir, outside visible Documents. The legacy terminal scripts continue to log to logs/launcher.log on the stick. The webview uses an incognito session and temporary data directory, and model caches are redirected to a private temporary folder. On quit the app closes the control stream, asks the service to stop, waits for model/UI cleanup and removes temporary storage. Loss of the native process closes stdin and triggers the same service cleanup. Forced termination, power loss and unplugging can defeat cleanup; the OS/webview can still write crash, swap or security records. No forensic-erasure claim is made.

## Dry run and qualification

```sh
npm run desktop:dry-run
node dist/portable/entry.js --desktop --dry-run --root /path/to/stick
```

A compiled native app also accepts `--dry-run` for a short plan without opening a webview or starting a model. The Node plan is exercised in the three-platform CI test matrix; it creates no folders, listeners or child processes.

TypeScript checks, build and unit tests run in the provided Linux workspace. Rust/Cargo are unavailable locally; native compilation is performed on the Intel Mac GitHub runner. See VERIFICATION.md for the actual run results. The live Ollama integration test remains opt-in. Real binaries and weights were not supplied, so a complete usable USB image cannot be produced from these source files alone.

Before release, verify clean Mac and Windows first-run behavior, both Mac architectures, Gatekeeper/notarization, SmartScreen, no terminal or administrator prompt, WebView2 availability, Linux WebKitGTK compatibility, cancel during loading/generation/swaps, normal quit/crash cleanup and temporary-folder removal. Measure cold and warm first replies with actual weights on 8 GB and 16 GB hardware, CPU inference memory pressure, slot status compatibility and USB read speed. There is no measured first-reply or sub-sixty-second swap guarantee here.

## App updates

Platform-specific desktop copies check for signed app updates on the welcome screen. Update and restart installs the app and runtimes while reusing models and preserving projects and logs. Private releases require read-only GitHub access saved separately in the user application configuration directory. Automatic checks can be disabled, and offline startup remains available. Older copies need one final complete download to gain the updater. See [UPDATES.md](UPDATES.md) for publisher setup, credentials, rollback and platform qualification limits.

## One app: Lite and Max

Current complete desktop releases include both Lite and Max in the same folder and use the title **Stick AI — Lite + Max**. Choose **Lite + Max** on the welcome screen for Lite to handle tools, approvals and file changes while Max writes larger code changes. Only one model is loaded at a time. **Lite only** disables delegation. **Max directly** is a conversational code-writing mode without tools. Max modes require at least 16 GiB reported RAM; Lite remains usable below that threshold. Max uses a 4096-token server context, small processing batches and disabled duplicate CPU weight repacking to reduce memory pressure. Available RAM and model performance still depend on the computer.

The welcome screen also lets you choose a single compatible Max GGUF elsewhere on your stick. The file is linked by path, never copied or downloaded. Selection is saved in `logs/max-model.json`; same-filesystem paths are stored relative to the app folder so moving the whole stick's contents retains the link. The file must remain connected and unchanged; changed or missing files can be selected again. Remove file link returns to the included Max, if present, without deleting either GGUF. File chooser support uses the system picker on macOS/Windows and Zenity on Linux; if a chooser is unavailable, paste the full path. Keep an additional user-supplied model outside the verified app folder. Do not place extra files inside the `.app` bundle.

GGUF header checks establish file format, not fine-tuning identity or code quality. The selected file is loaded by llama.cpp with its embedded chat template. A load failure is reported; Lite can finish the current task when the Max specialist fails. Source builds can still omit the optional Max file and link an existing model instead.


## Coding workspace

Open **Open workspace** on the launch screen. **Choose your Max GGUF** opens model settings and the native file chooser; linked weights stay in place. The workspace has a project file tree, conversation and composer, and a live activity panel. Thinking opens automatically for each task and streams reasoning actually emitted by the model. Some responses emit no separate reasoning; tool reads, searches, file writes and Lite-to-Max handoffs remain visible. Stop or Escape cancels current work. Selecting file text and copying with Ctrl+C does not cancel the model.

Click a project file to read or edit text under 1 MiB. Save or discard edits before switching files, projects or starting a model task. Saving is atomic and unavailable while the model or a GitHub operation is active. File edits and model changes stay inside the active project. Before/after GitHub review and publishing remain explicit actions. New conversation resets model history while retaining files; it is not a project deletion. Conversations currently survive a page reload within the same running service, not a full app restart.

Use **Connect GitHub** for repository workspaces, **Models & settings** for launch-screen model selection, and **App updates** on the launch screen for signed app-only updates. Check updates before opening the model session. Enter sends a message; Shift+Enter inserts a newline; Cmd/Ctrl+N starts a new conversation. Appearance can be switched between dark and light. The model still runs locally; this redesign does not add unattended cloud execution or automatic program execution.
