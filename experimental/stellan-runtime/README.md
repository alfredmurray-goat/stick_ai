# Stellan Runtime

An independent inference-engine experiment for Stellan, written by localilabs in C++20 under the repository's MIT licence. This code does not link, launch or depend on llama.cpp, ggml, Ollama or a model framework. It reads the published GGUF format and implements its own numerical routines. No third-party implementation code or new package dependencies are included.

This lives on `experimental/stellan-runtime`. The working desktop app, packaging, model security and existing inference engine are unchanged. This is a developer prototype, not a replacement engine that can run the assistant yet. It is not shipped in desktop releases. There is no speedup claim.

## First milestone

- Read-only memory mapping using POSIX mmap or Windows file mapping, without expanding all weights into RAM.
- Little-endian GGUF v2/v3 parsing, bounded metadata, overflow checks, alignment and tensor-range validation, duplicate and overlap rejection.
- Single-thread matrix-vector kernels for F32, F16, Q8_0 and Q4_K. Q4_K scales, minima and packed weights are consumed directly; the kernel does not allocate an expanded floating-point matrix.
- A grouped Mamba2 recurrent-state primitive, independently tested against the sequence's explicit closed-form sum, with an in-memory state-copy/resume check.
- Developer commands to inspect a GGUF and benchmark an individual matrix with machine-readable timings and an output checksum.
- Native numeric and malformed-file tests, with a separate CI matrix for Apple Silicon Mac, Intel Mac, Windows x64 and Linux x64, plus Linux sanitizers.

Q4_K_M is a mixed-tensor model preset, not a single tensor encoding. Such files also contain other storage types, including Q6_K. Inspection understands F32, F16, BF16, Q4_0, Q4_1, Q5_0, Q5_1, Q8_0 and Q2_K through Q6_K tensor sizes; computation currently supports only the four formats listed above. Unknown types and unsupported kernels fail explicitly. This is not full Q4_K_M inference support.

The Mamba2 primitive accepts already transformed per-head time steps and negative decay values, grouped B/C coefficients, a per-head skip parameter and caller-owned recurrent state. It implements one recurrent update, not the complete model layer. Projections, convolution, time-step bias/softplus, gating and normalisation remain to be integrated and checked against the exact Lite checkpoint.

## Build and test

Use a 64-bit C++20 compiler, CMake 3.20 or later and Python 3.10 or later for tests. These are developer tools, not new end-user requirements.

```sh
cmake -S experimental/stellan-runtime -B experimental/stellan-runtime/build -DCMAKE_BUILD_TYPE=Release
cmake --build experimental/stellan-runtime/build --config Release --parallel 2
ctest --test-dir experimental/stellan-runtime/build -C Release --output-on-failure
```

For a Linux/macOS machine without CMake:

```sh
c++ -std=c++20 -O3 -Wall -Wextra -Wpedantic -Werror experimental/stellan-runtime/src/runtime.cpp experimental/stellan-runtime/src/main.cpp -o /tmp/stellan-runtime
c++ -std=c++20 -O3 -Wall -Wextra -Wpedantic -Werror -I experimental/stellan-runtime/src experimental/stellan-runtime/src/runtime.cpp experimental/stellan-runtime/tests/core.cpp -o /tmp/stellan-runtime-tests
/tmp/stellan-runtime-tests
python3 experimental/stellan-runtime/tests/gguf.py /tmp/stellan-runtime
```

The CMake executable is `experimental/stellan-runtime/build/stellan-runtime` on Linux/macOS or `experimental/stellan-runtime/build/Release/stellan-runtime.exe` with Visual Studio. For example, on Linux/macOS:

```sh
experimental/stellan-runtime/build/stellan-runtime inspect /path/to/model.gguf
experimental/stellan-runtime/build/stellan-runtime tensorbench /path/to/model.gguf blk.0.ffn_down.weight 10
```

Select an actual two-dimensional tensor name from `inspect`. Repetitions range from 1 to 100. The benchmark limits a tensor to 256 MiB and each dimension to 1,048,576. It reports mapping/header time, the first matrix-vector call, warm median matrix-vector time, bytes processed and checksum. The activation vector is deterministic: `((i % 17) - 8) / 8`. SIGINT stops between calls; an individual kernel call finishes first. This developer interface may show diagnostic details; it is not a consumer UI.

An inspected file must be a complete, plain GGUF. Encrypted first splits from sold sticks and split-model resolution are not implemented. This utility does not decrypt models, fetch weights, contact a server or change files. Model files must not be edited or truncated while mapped. No tokenizer vocabulary or file contents are printed; `inspect` does print architecture and tensor names and dimensions. Hash/integrity verification remains mandatory before any eventual production integration; this standalone parser is not an integrity verifier.

## Next milestones

1. Audit the exact Lite tensor names, shapes, quantization mixture, tokenizer and training template. Implement remaining needed storage kernels, starting with Q6_K, with independent reference comparisons.
2. Add tokenization, embeddings, complete Mamba2 layers, normalisation, sampling and cached sequential state. Compare intermediate layers, logits and greedy output to the same plain GGUF in the pinned existing engine. Generate a real Lite response before treating this as model support.
3. Add a persistent worker pool and architecture-specific vector kernels. Profile first; validate scalar/vector agreement and test on real hardware. Investigate chunked Mamba2 prompt processing separately from single-token recurrence.
4. Implement Max's transformer path only after Lite parity: attention, RoPE, KV caching and all required storage kernels. Validate Lite and Max independently; do not assume either can act as the other's speculative draft.
5. Add a localhost-only streaming server, cancellation, request admission, memory budgeting and progress reporting. Keep the existing model-integrity, activation, split-model and approval boundaries when wiring it to the app behind an opt-in switch.
6. Compare full end-to-end tasks against the pinned bundled llama.cpp on the same hardware, weights, context, output length and CPU/GPU settings. Record cold USB load, time to first token, prompt throughput, decode throughput, peak RAM/VRAM, swap time and code correctness. A tensor microbenchmark is not an assistant-speed result.

The priority is an accurate Lite engine with measurable bottlenecks, then speed. A fresh engine does not remove the memory needed to hold Max's weights; smaller models or quantization need their own quality checks. Reinforcement learning for both models is deferred separately in [HANDOVER.md](../../HANDOVER.md).

## Format and mathematical references

- [GGUF specification](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md).
- [GGML quantization storage definitions](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-common.h), used to understand file layout, not copied as implementation code.
- [Mamba-2 paper](https://arxiv.org/abs/2405.21060) and [authors' model description](https://github.com/state-spaces/mamba).

These references describe interoperability and mathematics. This experiment has no linked third-party libraries; the repository's MIT licence and third-party notices remain unchanged.
