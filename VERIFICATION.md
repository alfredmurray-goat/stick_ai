# Desktop update verification

Verified in the supplied Linux workspace with Node.js 24.22.1:

- TypeScript strict application check and build passed.
- Strict type checking of all test files passed.
- 121 tests passed, including all 98 inherited tests; one live Ollama test was skipped as configured.
- New tests cover byte inactivity, SSE heartbeats beyond five minutes, live thought and summary streaming, specialist code streaming, progress timing, focused context, RAM boundaries, mocked launch order/failure cleanup, loading cancellation, repeated-idle faster settings and desktop bundle hashing/tampering.
- Legacy and desktop dry-run plans completed without launching an assistant.
- UI JavaScript and native-notice generator syntax checks passed.
- Third-party licence generation completed offline; no npm dependency was added.
- The original MIT LICENSE is byte-for-byte unchanged.

The container cannot exercise Linux bubblewrap isolation; its confinement test explicitly verifies the restricted-mode warning. This is not proof of kernel confinement.

Rust and Cargo are not installed in this environment. Native Tauri compilation, generated Cargo.lock, native runtime tests, signed bundles and hosted CI results are unverified. The CI matrix is source configuration, not evidence of a passing native build. No actual model weights or inference/runtime executables were supplied, so this archive contains source and build tooling, not a complete plug-and-play stick.

Release checks still needed on actual machines:

- Clean Mac and Windows first-run experience, no terminal or administrator prompt, both Mac architectures and Linux system-webview compatibility.
- Gatekeeper/notarization and SmartScreen prompts for the desktop app and all nested runtimes.
- Cancellation and quit/crash cleanup during hashing, loading, inference and swaps, including temporary webview data and owned process trees.
- Actual Stellan GGUF/template/protocol compatibility, authenticated health/slot behavior and local-only listeners.
- Cold and warm first-reply times, total memory pressure and swap times on 8 GB and 16 GB machines using the actual USB storage and weights.
- Complete resolved Rust and supplied native-runtime redistribution notices, signed asset provenance and final manifest verification after packaging.
