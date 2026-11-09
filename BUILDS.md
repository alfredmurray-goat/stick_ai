# Desktop Lite packages

The `Desktop Lite builds` workflow in `.github/workflows/desktop.yml` builds four independent, complete folders. Run it from GitHub Actions or push a source change to main. Documentation-only pushes do not rebuild the multi-gigabyte packages. The older Intel-only workflow remains available manually.

| Artifact | Native target | Bundled Node | Desktop entry point |
| --- | --- | --- | --- |
| stick_ai-macos-arm64 | aarch64-apple-darwin | darwin-arm64 | Stick AI.app |
| stick_ai-macos-x64 | x86_64-apple-darwin | darwin-x64 | Stick AI.app |
| stick_ai-windows-x64 | x86_64-pc-windows-msvc | win-x64 | Stick AI.exe |
| stick_ai-linux-x64 | x86_64-unknown-linux-gnu | linux-x64 | stick-ai |

Each folder contains the Lite GGUF, native desktop app, portable Node runtime, inference server, web UI, technical fallback launcher, manifest and redistribution notices. Max weights are not included. The source still supports optional Max and the existing RAM lock and model swapping. No new npm dependencies are required for packaging.

## Inputs and compatibility

- Lite: `OfficialSejeGed/stellan-1-lite-gguf`, revision `94f4d2ffd0990289cda48d9505844f90ac6e7144`, file `stellan-1-lite-q4_k_m.gguf`, 4,147,481,440 bytes, SHA256 `84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e`.
- llama.cpp: tag `v0.9.0`, exact source commit `cd959bae99ff4bed22bef2604f45241c09bbb8c8`. All four servers are compiled from that source with shared project libraries, OpenMP, OpenSSL and external BLAS disabled. CPU execution is the compatibility baseline. Windows server and desktop builds request static C runtime linkage.
- Node: version `24.22.1`. `scripts/fetch-platform-assets.mjs` pins each archive's SHA256 from the official `https://nodejs.org/dist/v24.22.1/SHASUMS256.txt` and verifies it before extraction. Downloads and build tools need internet; the prepared app has no download or update step.
- Tauri: the checked-in `src-tauri/Cargo.lock` pins native dependencies. The builder collects the resolved target's full notices and required covered source, plus the pinned llama.cpp source archive. Missing notices fail the build.

The supplied Lite is Mamba2 with no embedded chat template. Each package writes `app/model-templates.json` selecting the tested Mistral-v1 compatibility formatter, and starts Lite with `--no-jinja --skip-chat-parsing`. Managed Lite requests use the tagged-response grammar. One slot, disabled CPU repacking and prompt caching, and smaller batches reduce memory use. These settings do not prove general model accuracy or the original training template.

## Requirements

All desktop packages require at least 8 GiB reported system memory. The x64 inference builds target AVX2-capable Intel/AMD CPUs; older x64 processors without those instructions are not qualified. Macs require macOS 13.5 or newer. Windows requires Windows 10 or newer and an existing Microsoft Edge WebView2 runtime. The Linux native executable targets glibc 2.35 or newer with GTK 3 and WebKitGTK 4.1 already available. It is not an AppImage and does not bundle those system libraries. Computers without the required system webview cannot run the desktop app without additional setup; the technical browser fallback uses the bundled Node and an existing browser.

Extract the Actions ZIP, then extract its inner ZIP or tar.gz. Keep the folder together. Linux tar preserves executable bits; Windows archives need no administrator privileges. Artifacts are retained for 14 days. The models and native outputs are download artifacts rather than oversized Git blobs. Preserve a downloaded copy or run the workflow again after expiry.

The apps are unsigned. Clean first launch, Gatekeeper, SmartScreen, physical USB behavior, visual progress/cancellation and performance on 8 GB and 16 GB machines need manual verification. A CI native dry-run does not open or qualify the actual GUI.

## Build gates

Each job runs strict TypeScript checks, the unit suite, the app build, notice generation and desktop dry-run. It builds the correct native app and Mamba2 server, verifies all release input hashes, checks executable architecture, assembles an atomic staging directory and verifies the complete manifest before publishing.

`scripts/smoke-platform.mjs` executes the native app's dry-run, checks macOS library portability or missing Linux shared libraries, starts the real Lite server on authenticated loopback, streams a tagged completion, then runs a real read_file/tool_result/done exchange against an unknown note. A failure prevents uploading a complete package. Diagnostic artifacts retain the Cargo lockfile, model logs and protocol transcript. Test success is basic integration evidence; review all proposed source changes.

For local packaging after `npm run build`, `scripts/package-platform.ts` accepts `--out`, `--app`, `--node`, `--node-license`, `--server`, `--server-license`, `--lite` and `--desktop-licenses`. It detects the current host's supported target and rejects mismatched executables. Use the workflow as the complete native build recipe; cross-compiling a single executable is insufficient to create a qualified package for another OS. `scripts/package-intel.ts` remains compatible with the previous Intel recipe. `scripts/build-stick.ts` remains the universal-stick assembler for supplied assets from all four platforms and both models.
