# Desktop Lite build verification

Verified on 9 November 2026.

## Published downloads

[All four desktop builds in GitHub Releases](https://github.com/alfredmurray-goat/stick_ai/releases/tag/lite-42573615107).

[Successful four-platform build](https://github.com/alfredmurray-goat/stick_ai/actions/runs/42573615107).
Build source: `1e9a88d61807dbd9cdad2b729968fd66fdf7b728`.

The release contains permanent split archives, checksum-verifying join helpers and RELEASE_CHECKSUMS.json. Its notes also link complete single-download packages until 23 November 2026. Extract the Actions ZIP and then its inner archive; keep the resulting folder together. The Linux inner archive is tar.gz to preserve permissions. See [BUILDS.md](BUILDS.md) for permanent-part preparation and rebuilding.

| Platform | Complete Actions download | Outer artifact bytes | Outer artifact SHA256 |
| --- | --- | ---: | --- |
| Apple Silicon Mac | [Complete package](https://github.com/alfredmurray-goat/stick_ai/actions/runs/42573615107/artifacts/13655170254) | 4,143,987,308 | `a738f7ede31bb0cd0b25b1be87be5771ee2e670558cbc77815e67afcbec4fb11` |
| Intel Mac | [Complete package](https://github.com/alfredmurray-goat/stick_ai/actions/runs/42573615107/artifacts/13654304784) | 4,145,939,795 | `b0e9183e5c131af713cf49b2c968fff9dfa31db80fde325a7a26d9d093e39ef3` |
| Windows x64 | [Complete package](https://github.com/alfredmurray-goat/stick_ai/actions/runs/42573615107/artifacts/13654772620) | 4,307,475,431 | `0825861c02079714a29a78dc40f6173a7f8a365b903350fd675a325e8948137a` |
| Linux x64 | [Complete package](https://github.com/alfredmurray-goat/stick_ai/actions/runs/42573615107/artifacts/13654319216) | 4,144,386,110 | `f54f4e684a6b6c5aac9c20bd37613ad378703d492de8d3854c7d9140cb26770c` |

These hashes refer to the outer GitHub artifact ZIPs. RELEASE_CHECKSUMS.json separately records the inner archives and each permanent release part.

## Passed checks

- Strict TypeScript checks passed for the application and locally for test files.
- All 133 local tests passed, including the 98 inherited tests; the independent Ollama integration test remains opt-in.
- Each of the four hosted jobs passed 132 tests. The independent Ollama test and the separately qualified Linux status-process supervisor scenario were skipped where their host requirements were absent; the latter passed locally. No added test disables a required platform check.
- Native Tauri apps compiled for macOS ARM64, macOS x64, Windows x64 and Linux x64. Each executed its native dry-run.
- The matching Mamba2-capable llama.cpp server compiled from v0.9.0, exact commit cd959bae99ff4bed22bef2604f45241c09bbb8c8.
- macOS otool checks found only system library dependencies; Linux ldd checks found no missing libraries. Windows desktop and server builds request static C runtime linkage; clean-machine dependency qualification remains manual.
- Node and Lite downloads matched pinned SHA256 values before extraction or use.
- Each assembled package passed executable architecture checks and complete manifest verification.
- On all four native runners, the real Lite server loaded on authenticated loopback, passed identity checks and rejected an invalid key.
- Each platform streamed a tagged completion and completed an actual read_file/tool_result/done exchange, reading an unknown generated note and accurately reporting its full contents.
- The longest generated README.txt is 149 words, below the 200-word limit.
- Real archive assembly and artifact uploads passed on every platform. CI removes the copied model input before archiving to bound disk use.
- The release splitter and join helpers passed tests, including a tampered part and actual Windows/Unix helper execution. The publisher also passed a mocked end-to-end draft/upload/publish sequence.
- Lite retains one slot, disabled CPU weight repacking and RAM prompt caching, smaller processing batches and its configured 8192 context. Model requests use the tagged grammar and explicit Mistral-v1 compatibility formatter.
- Silent model requests have no application inactivity deadline. Live thinking/progress, reduced context and cancellation behavior remain covered by tests.
- Authored stick_ai code remains MIT. No new npm dependencies were added. The native notices include required covered source and the pinned llama.cpp source archive.

## Model accuracy and performance limits

The supplied Lite file identifies itself as mamba2, 7.3B, with a Mistral-style tokenizer and no embedded chat template. The old b5046 server cannot load it. Mistral-v1 is a tested compatibility formatter; the original training template and Lite base-model provenance remain unverified.

In the earlier 8 GiB-limited Linux diagnostic environment, disabling duplicate CPU weight repacking reduced observed server resident memory from approximately 7.7 GiB to approximately 4.2 GiB during a simple test. This is not a performance or total-memory guarantee for a buyer's computer.

Repeated long random UUID readback tests were inconsistent, including invented file contents. The generated-note check proves basic tool/protocol integration, not comprehensive coding accuracy. Review proposed changes and verify important facts.

The hosted native integration steps took approximately 1m46s on Apple Silicon Mac, 1m59s on Intel Mac, 6m11s on Linux and 5m01s on Windows. These include startup and multiple model exchanges; they are not first-reply benchmarks and do not predict USB or physical 8 GB/16 GB performance.

## Still needs real-machine verification

- Clean first launch on Intel Mac, Apple Silicon Mac and Windows, including Gatekeeper, quarantine and SmartScreen behavior for the app and nested runtimes.
- Signing/notarization and Windows signing: these are unsigned prerelease test builds.
- The actual desktop welcome, native IPC/navigation, progress, thinking and Cancel controls; native dry-run does not open the GUI.
- Longer conversations and larger coding tasks with the supplied Lite weights, beyond the bounded generated-note check.
- First reply, sustained memory pressure and model-switch behavior on physical 8 GB and 16 GB machines using real USB storage.
- Close-window, Ctrl+C fallback, crash, forced quit, unplug/reinsert and temporary-file cleanup behavior, including browser/webview OS caches.
- Windows WebView2 availability and Linux GTK 3/WebKitGTK 4.1 availability on clean computers. These system components are prerequisites, not bundled installers.
- Linux distribution/desktop compatibility and older x64 CPU instruction support; x64 inference builds target AVX2-capable CPUs.
- Standalone Max and real Lite/Max swaps: Max weights are not included in these packages and no Max hardware qualification is claimed.
- Independent Ollama behavior with the actual Lite weights; the hosted live-model checks used the packaged llama.cpp server.

Macs require macOS 13.5 or newer; Windows requires Windows 10 or newer with WebView2, and Linux requires glibc 2.35 or newer with its stated webview components. All desktop packages require at least 8 GiB reported memory.

The container's Linux confinement test explicitly asserted its restricted-mode warning because bubblewrap could not enforce isolation there. Automated platform tests check confinement when available or assert the fallback warning; they do not prove isolation on every host. The portable UI continues to disable run_shell.
