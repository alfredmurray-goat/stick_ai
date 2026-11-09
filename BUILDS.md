# Desktop packages — Lite + Max

The `Desktop builds — Lite + Max` workflow in `.github/workflows/desktop.yml` builds four independent, complete folders. Run it from GitHub Actions or push a source change to main. Documentation-only pushes do not rebuild the multi-gigabyte packages. The older Intel-only workflow remains available manually.

| Artifact | Native target | Bundled Node | Desktop entry point |
| --- | --- | --- | --- |
| stick_ai-macos-arm64 | aarch64-apple-darwin | darwin-arm64 | Stick AI.app |
| stick_ai-macos-x64 | x86_64-apple-darwin | darwin-x64 | Stick AI.app |
| stick_ai-windows-x64 | x86_64-pc-windows-msvc | win-x64 | Stick AI.exe |
| stick_ai-linux-x64 | x86_64-unknown-linux-gnu | linux-x64 | stick-ai |

Each complete released folder contains both Lite and Max GGUFs, native desktop app, portable Node runtime, inference server, web UI, technical fallback launcher, manifest and redistribution notices. The same app offers Lite, Lite + Max pairing, and direct Max code generation, with the existing RAM lock. No new npm dependencies are required for packaging.

## Inputs and compatibility

- Lite: `OfficialSejeGed/stellan-1-lite-gguf`, revision `94f4d2ffd0990289cda48d9505844f90ac6e7144`, file `stellan-1-lite-q4_k_m.gguf`, 4,147,481,440 bytes, SHA256 `84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e`.
- llama.cpp: tag `v0.9.0`, exact source commit `cd959bae99ff4bed22bef2604f45241c09bbb8c8`. All four servers are compiled from that source with shared project libraries, OpenMP, OpenSSL and external BLAS disabled. CPU execution is the compatibility baseline. Windows server and desktop builds request static C runtime linkage.
- Node: version `24.22.1`. `scripts/fetch-platform-assets.mjs` pins each archive's SHA256 from the official `https://nodejs.org/dist/v24.22.1/SHASUMS256.txt` and verifies it before extraction. Downloads and build tools need internet; model inference works offline; the separate app updater checks GitHub unless checks are disabled.
- Tauri: the checked-in `src-tauri/Cargo.lock` pins native dependencies. The builder collects the resolved target's full notices and required covered source, plus the pinned llama.cpp source archive. Missing notices fail the build.

The supplied Lite is Mamba2 with no embedded chat template. Each package writes `app/model-templates.json` selecting the tested Mistral-v1 compatibility formatter, and starts Lite with `--no-jinja --skip-chat-parsing`. Managed Lite requests use the tagged-response grammar. One slot, disabled CPU repacking and prompt caching, and smaller batches reduce memory use. These settings do not prove general model accuracy or the original training template.

## Requirements

All desktop packages require at least 8 GiB reported system memory. The x64 inference builds target AVX2-capable Intel/AMD CPUs; older x64 processors without those instructions are not qualified. Macs require macOS 13.5 or newer. Windows requires Windows 10 or newer and an existing Microsoft Edge WebView2 runtime. The Linux native executable targets glibc 2.35 or newer with GTK 3 and WebKitGTK 4.1 already available. It is not an AppImage and does not bundle those system libraries. Computers without the required system webview cannot run the desktop app without additional setup; the technical browser fallback uses the bundled Node and an existing browser.

Download the permanent release parts and platform Join helper, join them, and extract the finished ZIP or tar.gz. Keep the folder together. Linux tar preserves executable bits; Windows archives need no administrator privileges. Temporary Actions base artifacts expire after one day and are not complete consumer downloads. Release assets remain available. Allow roughly 60 GB free while keeping parts, the joined archive and the extracted two-model folder together; the final app folder is about 18.5 GB.

The apps are unsigned. Clean first launch, Gatekeeper, SmartScreen, physical USB behavior, visual progress/cancellation and performance on 8 GB and 16 GB machines need manual verification. A CI native dry-run does not open or qualify the actual GUI.

## Build gates

Each job runs strict TypeScript checks, the unit suite, the app build, notice generation and desktop dry-run. It builds the correct native app and Mamba2 server, verifies all release input hashes, checks executable architecture, assembles an atomic staging directory and verifies the complete manifest before publishing.

`scripts/smoke-platform.mjs` executes the native app's dry-run, checks macOS library portability or missing Linux shared libraries, starts the real Lite server on authenticated loopback, streams a tagged completion, then runs a real read_file/tool_result/done exchange against an unknown note. A failure prevents uploading a complete package. Diagnostic artifacts retain the Cargo lockfile, model logs and protocol transcript. Test success is basic integration evidence; review all proposed source changes.

For local packaging after `npm run build`, `scripts/package-platform.ts` accepts `--out`, `--app`, `--node`, `--node-license`, `--server`, `--server-license`, `--lite`, optional `--max`, and `--desktop-licenses`. It detects the current host's supported target and rejects mismatched executables. Use the workflow as the complete native build recipe; cross-compiling a single executable is insufficient to create a qualified package for another OS. `scripts/package-intel.ts` remains compatible with the previous Intel recipe. `scripts/build-stick.ts` remains the universal-stick assembler for supplied assets from all four platforms and both models.

## GitHub Releases

`.github/workflows/release.yml` publishes a prerelease automatically after a successful Desktop builds — Lite + Max run on main. It validates the trusted run, requires all four unexpired package artifacts, creates a draft and publishes only after every asset and the checksums have uploaded. A manual dispatch accepts a successful build run ID for recovery. The release tag points at the tested build source commit.

The release page contains complete two-model packages as permanent parts. GitHub limits each release asset to less than 2 GiB, so permanent copies are split into parts no larger than 2000 MiB. Download all parts for one platform and its Join helper into the same directory. Extract a helper ZIP there, then open the helper once. The helper verifies every part and the reconstructed archive before reporting completion; no commands need to be typed. This one-time preparation shows a terminal, unlike the desktop app. Mac/Linux helpers are zipped to preserve executable permissions. Windows uses a batch helper and built-in PowerShell. Keep the original parts until the app has been checked.

`RELEASE_CHECKSUMS.json` records the source commit, build run, original archive sizes/hashes and every part's size/hash. The publisher processes one platform at a time to bound disk use. Failed publication leaves a draft for retry; it does not expose a partial release. This does not sign or notarize the application.

## Unified Lite + Max releases

The current workflow is **Desktop builds — Lite + Max**. Complete published packages contain both GGUFs in one app. Max is the user-confirmed original `OfficialSejeGed/stellan-1.0-gguf` model, pinned to revision `fe3b67d162d4b15f0d0b942dd527f7a3382a414d`, SHA256 `05f00035de8a3893601cec2644f921be240938aab4ff4736ed2f1b6dbcda8dc1`, size 14,333,915,200 bytes. The runtime name is Stellan-1 Max; the upstream filename remains `stellan-1.0-q4_k_m.gguf`.

To limit Actions cost and runner disk use, the four native build jobs test Lite and create internal base artifacts with the pinned optional Max manifest entry. These base artifacts are not complete user downloads. The Linux publisher downloads/verifies Max once, adds it to each platform package, verifies both model files, and creates the permanent complete archives. Parts upload and are deleted one at a time to bound disk use. Complete archives are approximately 18.5 GB before compression; download every part and the platform Join helper. Temporary base/update artifacts expire after one day; permanent release assets remain. An app-only signed update never contains model bytes.

Max metadata identifies a 23.6B llama architecture and an embedded Devstral/Mistral chat template. The hosted build runners test real Lite inference. Max's pinned file and full package integrity are checked during publication; these runners do not qualify real Max inference or Lite/Max swapping under 16 GiB memory pressure. Test the complete app with the actual Max model on the target hardware before treating model accuracy or performance as established.

## Picker updates publish first

After all platform builds pass, the publisher creates a small signed app-only release before downloading or packaging the full Max weights. Existing Lite app users can choose Check for updates and Update and restart to obtain the file picker without waiting for or downloading the two-model packages. The full Lite + Max release follows from the same checked build. Standard GitHub-hosted runner compute is free for this now-public repository; artifact/cache storage and runner/concurrency limits remain separate.
