# Intel Mac Lite build verification

Verified on 8 November 2026.

## Downloadable build

The Intel Mac packaging run succeeded:

https://github.com/alfredmurray-goat/stick_ai/actions/runs/42517759406

Build commit: 1f7b166981922d5e6982f11437cc422f533ecf91

Complete Lite-only app artifact:

https://github.com/alfredmurray-goat/stick_ai/actions/runs/42517759406/artifacts/13632203606

Artifact archive size: 4,145,940,806 bytes.
Artifact SHA256: 3b826d7d9cd872460821010e85f164380b8fa82b96dac00809d150c7e59074d3
The artifact expires on 11 November 2026 at 21:20 Copenhagen time. Download and retain a local copy. The GitHub source and pinned model inputs remain available for rebuilding.

The download contains a ZIP inside the GitHub artifact ZIP so the app's executable permissions are preserved. Extract both layers, keep the resulting folder together, open Stick AI.app and click Start. This build requires an Intel Mac with macOS 13.5 or newer and at least 8 GiB RAM. Lite and its local runtimes are included; Max is not included.

## Passed checks

- Strict TypeScript application and test-file checks passed locally.
- All 127 unit tests passed, including the 98 inherited tests; the independent live Ollama test remains opt-in and skipped.
- The native Tauri application and pinned llama.cpp v0.9.0 server compiled for Intel macOS.
- The native application executed its dry-run successfully.
- The binary architecture checks and otool library checks passed without dependencies on Homebrew libraries.
- Model and portable Node downloads passed their pinned SHA256 checks.
- Package assembly and complete manifest verification passed.
- The real Lite model loaded on the Intel Mac runner with authenticated loopback readiness checks.
- A streamed tagged reply and an actual read_file/tool_result/done exchange passed. The assistant read a note containing an unknown random suffix and accurately reported its contents.
- Runtime CPU weight repacking, large RAM prompt caching and recurrent checkpoint copies are disabled for Lite; smaller processing batches preserve the configured 8192 context window.
- The default inactivity interval remains 300 seconds, reset by received bytes, with configurable settings and progress/cancellation support.
- The MIT licence for authored stick_ai code is unchanged. Resolved native notices, required covered source and the pinned llama.cpp source archive accompany the app.

## Model accuracy and performance limits

The supplied Lite file identifies itself as mamba2, 7.3B, with a Mistral-style tokenizer and no embedded chat template. The old b5046 server cannot load that architecture. The packaged Mistral-v1 formatter is a tested compatibility fallback; the original training template and Lite base-model provenance have not been supplied or verified.

In an 8 GiB-limited Linux diagnostic environment, disabling duplicate CPU weight repacking reduced observed server resident memory from approximately 7.7 GiB to approximately 4.2 GiB during a simple test. These are diagnostic observations, not performance guarantees for an 8 GB Mac.

Repeated long random UUID readback tests were inconsistent, including hallucinated file contents. The readable-note integration test verifies basic tool/protocol integration, not comprehensive coding accuracy. Review proposed changes and verify important facts.

The hosted Mac integration step took about two minutes and twenty-one seconds, including startup and the test exchanges. This is not a benchmark of the buyer's machine or a promise about first-reply latency.

## Still needs real-machine verification

- Clean first launch on the user's Intel Mac, including Gatekeeper and quarantine handling for the app and nested runtimes.
- Signing and notarization: this is an unsigned test build, not a qualified signed buyer release.
- Visual welcome, progress, thinking and Cancel behavior inside the actual desktop window.
- Performance and memory pressure on physical 8 GB and 16 GB Intel Macs using the actual USB storage.
- Window-close, crash, unplug/reinsert and temporary-file cleanup behavior.
- Actual Stellan Max behavior and swap timings; this Lite-only package makes no Max qualification claim.
- Native Windows and Linux desktop qualification; only the Intel Mac package is supplied here.

The container's Linux sandbox confinement test asserted the restricted-mode warning because bubblewrap could not enforce isolation there; that is not proof of kernel confinement. The portable UI continues to disable run_shell.
