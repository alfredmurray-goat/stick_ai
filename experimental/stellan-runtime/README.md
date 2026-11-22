# Stellan Runtime

An independent C++20 inference-engine experiment by localilabs, under the repository's MIT licence. The engine does not link or launch llama.cpp, ggml or Ollama. Its optional Node.js bridge uses only built-in modules from the app's existing Node runtime. No new npm dependencies or third-party implementation code are included.

Work stays on `experimental/stellan-runtime`. The production app still uses its existing engine. This prototype is **not a drop-in desktop replacement**, has no production HTTP server or GPU backend yet, and must not be advertised as faster or more secure than the existing engine.

## What works and what has been checked

| Component | Implemented | Verification |
| --- | --- | --- |
| GGUF | Read-only POSIX/Windows mapping; v2/v3; bounded metadata, UTF-8, dimensions, offsets and overlap checks | Truncation, corruption, seeded mutation and overflow fixtures |
| Quantized math | F32/F16/Q8_0/Q4_K/Q6_K; packed weights remain packed | Independent packed-format references; scalar and vector paths |
| Acceleration | AVX2/FMA/F16C on capable x64 CPUs; NEON on ARM64; persistent CPU workers | Linux numerical tests; cross-platform compilation and fixture CI |
| Activation quantization | Per-256-value signed 8-bit inputs, shared across matrix rows, with cached group sums | Compared against the represented floating-point inputs; end-to-end quality still needs broad evaluation |
| Lite | Embeddings, complete Mamba2 blocks, convolution, recurrent state, gating, group RMS normalization, output projection and greedy decoding | Real pinned Lite GGUF generated a Python add function; independent full-layer numerical fixtures |
| Max | Separate transformer path: grouped-query attention, RoPE, SwiGLU, residuals, FP16 KV cache and greedy decoding | Independent numerical fixtures through multiple positions and layers; full Max weights have not been run here |
| Tokenizers | SentencePiece BPE for Lite; Unicode-aware Tekken byte BPE for Max | Max matched eight local Hugging Face tokenizers reference cases including code, Danish, Chinese and emoji; synthetic regression tests |
| Integrity | Trusted executable hash checked by the bridge; trusted model SHA256 required before native inference | Tampered executable/model rejection; NIST vectors and Python hashlib comparisons at padding boundaries |
| RAM lock | Lite available at 8 GB; Max blocked below 16 GB with explicit force override and warning | 8 GB, 15.9 GB and 16 GB plan tests; native guard for large model files |

The real Lite has 64 Mamba2 layers, embedding width 4096, inner width 8192, 128 heads, 8 groups and state width 128. Its official file is 4,147,481,440 bytes, SHA256 `84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e`.

The audited Max header describes 40 transformer layers, embedding width 5120, 32 query heads, 8 KV heads, head width 128, FFN width 32768 and a 131072-entry Tekken vocabulary. The official Max file is 14,333,915,200 bytes, SHA256 `05f00035de8a3893601cec2644f921be240938aab4ff4736ed2f1b6dbcda8dc1`. Header inspection and fixture execution are not proof that the full checkpoint works.

Q4_K_M is a mixture of tensor formats; both Q4_K and Q6_K computation are required. Other formats may be inspected but are refused for execution. Encrypted/split release models, production activation and signatures are not integrated into this engine yet. Use complete plain GGUFs only for these development tests. Never commit weights or keys.

## Build and test

Use a 64-bit C++20 compiler, CMake 3.20 or later, Python 3.10 or later for tests, and the repository's Node.js 24.22.1. These are developer tools; consumer app installation requirements have not changed.

```sh
cmake -S experimental/stellan-runtime -B experimental/stellan-runtime/build -DCMAKE_BUILD_TYPE=Release
cmake --build experimental/stellan-runtime/build --config Release --parallel 2
ctest --test-dir experimental/stellan-runtime/build -C Release --output-on-failure
node --test experimental/stellan-runtime/tests/node-checks.mjs
```

The executable is `build/stellan-runtime` on Linux/macOS and `build/Release/stellan-runtime.exe` with Visual Studio, relative to this directory. The separate workflow tests Apple Silicon Mac, Intel Mac, Windows x64, Ubuntu, and Linux address/undefined-behaviour sanitizers. CI fixtures do not establish physical-device performance or GPU support.

`STELLAN_RUNTIME_SCALAR=1` disables vector kernels for comparison. `STELLAN_RUNTIME_PRECISE=1` uses floating-point activations instead of the fast quantized input path; weight files are unchanged in either mode. Quantization can change logits and generated text. Every speed result must name the mode and include quality evaluation.

## Developer commands

```sh
experimental/stellan-runtime/build/stellan-runtime inspect /path/to/model.gguf
experimental/stellan-runtime/build/stellan-runtime hash /path/to/model.gguf
experimental/stellan-runtime/build/stellan-runtime tensorbench /path/to/model.gguf blk.0.ssm_in.weight 10
```

Inspection prints architecture and tensor layouts, not vocabulary or file contents. Tensor benchmarks measure a single matrix with deterministic inputs, not assistant speed. The `generation_supported: false` inspection field remains conservative: the engine has not passed production qualification.

For actual text generation, use the Node bridge with trusted hashes from your own build/verified release inputs:

```sh
node experimental/stellan-runtime/run.mjs \
  --engine experimental/stellan-runtime/build/stellan-runtime \
  --engine-sha256 TRUSTED_EXECUTABLE_SHA256 \
  --model /path/to/stellan-1-lite-q4_k_m.gguf \
  --sha256 84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e \
  --prompt '<s>[INST] Write a Python function add(a, b). [/INST]' \
  --tokens 64 --threads 2 --context 8192
```

For Max, change the model file and trusted model hash to the Max values above. The bridge chooses its Tekken tokenizer and the native transformer executor. Under 16 GiB, `--force-max` is required and prints a warning. It does not make the weights fit in memory. The bridge preserves incomplete UTF-8 token fragments with a streaming decoder, sends token IDs over a pipe and never sends prompts to a network service.

The native diagnostic commands are `generate MODEL SHA256 PROMPT [TOKENS] [THREADS] [CONTEXT]` for Lite, or `decode MODEL SHA256 COMMA_SEPARATED_IDS [TOKENS] [THREADS] [CONTEXT]` for either architecture. `-` reads IDs from stdin, avoiding Windows command-line length limits. Native Max raw-text tokenization is deliberately refused; use the bridge's Tekken tokenizer. The CLI writes newline-delimited JSON progress, tokens and timings. `hash` supports nonempty files; empty-input hashing is covered in core tests.

Max's default KV context is 8192, configurable downwards in the bridge. Its FP16 cache uses about 1.25 GiB at that setting, in addition to weights and working memory. Lite's recurrent state/history is 276,299,776 bytes, independent of prompt length. Context and allocation budgets fail explicitly. Models must not be modified or truncated while mapped.

Each bridge request currently starts a new native process and re-verifies the model. The native state and workers remain alive within that request, not between tool calls. This startup cost is a known blocker for app integration. SIGINT/SIGTERM cancel generation; the bridge terminates an unresponsive child after two seconds. A child is never started with a shell. This developer interface can show diagnostics; it is not the consumer UI.

## Evidence and replacement gate

See [EVIDENCE.md](EVIDENCE.md) for the actual Linux probes, their limitations and remaining work. No measured Max speed, physical Mac/Windows speed, lower host load, or general superiority is claimed.

`node experimental/stellan-runtime/promotion.mjs REPORT.json` rejects missing platform/model evidence, mismatched settings, regressions and unvalidated security/packaging checks. Reports need at least five paired repetitions, twenty completed agent tasks, the same verified weights/prompts/context/sampling/hardware, the actual shipped baseline configuration, and evidence links. Median first-token latency and CPU time/peak resident memory must improve by at least 5%, generation throughput by at least 5%, without a cold-start regression.

This is a structural eligibility check, not independent proof of the assertions in a report, a security audit or an automatic merger. Inspect the raw results and exact candidate commit. A short CPU probe, a CI virtual machine, disabling the baseline's normal GPU acceleration, or a smaller context cannot establish that the app is better. Main must keep its existing engine until all conditions are met for both models.

The next priorities are persistent model processes and stable prompt caching, batched prompt processing, faster integrity verification using the existing trusted app pipeline, complete checkpoint/agent validation for Max on sufficient RAM, physical-device profiling, GPU execution, encrypted/split model support, secure streaming serving and desktop integration. Keep approvals and all privacy/integrity/activation checks when integrating. The deferred reinforcement learning and unnamed open-source demonstration plan are in [HANDOVER.md](../../HANDOVER.md).

## References

The implementation uses the published [GGUF format](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md), [quantization storage layouts](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-common.h), [Mamba-2 mathematics](https://arxiv.org/abs/2405.21060), standard transformer operations and SHA256. These are interoperability/mathematical references, not copied runtime implementations. Optional local comparisons against existing engines or Hugging Face tokenizers do not add those libraries to this runtime or its shipped dependencies. The repository's MIT licence and existing third-party notices remain applicable.

## Verification startup improvement

The portable SHA-256 path checks every byte as before, with less per-block overhead and no new dependencies. On this development host, alternating full-Lite verification runs measured median **19.05 s → 12.12 s**. This improves model verification only; it does not establish faster generation or superiority to llama.cpp. See [the measurement and limitations](EVIDENCE.md#verification-optimization-22-november-2026) and [raw timings](evidence/verification-probe.json).
