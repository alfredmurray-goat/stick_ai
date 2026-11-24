# Stellan-Run

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

Max's default KV context is 8192, configurable downwards in the bridge. The persistent Lite bridge accepts the app's 65536/262144 context budgets without a token-sized state allocation; this capacity check is not long-context quality validation. Its FP16 cache uses about 1.25 GiB at that setting, in addition to weights and working memory. Lite's recurrent state/history is 276,299,776 bytes, independent of prompt length. Context and allocation budgets fail explicitly. Models must not be modified or truncated while mapped.

`run.mjs` is a one-shot diagnostic and starts a fresh, fully verified process for each request. `session.mjs` retains a verified model, decoder and worker pool across requests; use that interface for persistent-session development. SIGINT/SIGTERM cancel generation; the bridge terminates an unresponsive child after two seconds. A child is never started with a shell. This developer interface can show diagnostics; it is not the consumer UI.

## Evidence and replacement gate

See [EVIDENCE.md](EVIDENCE.md) for the actual Linux probes, their limitations and remaining work. No measured Max speed, physical Mac/Windows speed, lower host load, or general superiority is claimed.

`node experimental/stellan-runtime/promotion.mjs REPORT.json` rejects missing platform/model evidence, mismatched settings, regressions and unvalidated security/packaging checks. Reports need at least five paired repetitions, twenty completed agent tasks, the same verified weights/prompts/context/sampling/hardware, the actual shipped baseline configuration, and evidence links. Median first-token latency and CPU time/peak resident memory must improve by at least 5%, generation throughput by at least 5%, without a cold-start regression.

This is a structural eligibility check, not independent proof of the assertions in a report, a security audit or an automatic merger. Inspect the raw results and exact candidate commit. A short CPU probe, a CI virtual machine, disabling the baseline's normal GPU acceleration, or a smaller context cannot establish that the app is better. Main must keep its existing engine until all conditions are met for both models.

The next priorities are production integration of persistent sessions and prompt caching, further matrix-kernel improvements, integrity verification using the existing trusted app pipeline, complete checkpoint/agent validation for Max on sufficient RAM, physical-device profiling, GPU execution, encrypted/split model support, secure streaming serving and desktop integration. Keep approvals and all privacy/integrity/activation checks when integrating. The deferred reinforcement learning and unnamed open-source demonstration plan are in [HANDOVER.md](../../HANDOVER.md).

## References

The implementation uses the published [GGUF format](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md), [quantization storage layouts](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-common.h), [Mamba-2 mathematics](https://arxiv.org/abs/2405.21060), standard transformer operations and SHA256. These are interoperability/mathematical references, not copied runtime implementations. Optional local comparisons against existing engines or Hugging Face tokenizers do not add those libraries to this runtime or its shipped dependencies. The repository's MIT licence and existing third-party notices remain applicable.

## Verification startup improvement

The portable SHA-256 path checks every byte as before, with less per-block overhead and no new dependencies. On this development host, alternating full-Lite verification runs measured median **19.05 s → 12.12 s**. This improves model verification only; it does not establish faster generation or superiority to llama.cpp. See [the measurement and limitations](EVIDENCE.md#verification-optimization-22-november-2026) and [raw timings](evidence/verification-probe.json).

## Persistent local sessions

Stellan-Run now has a pipe-only persistent worker (`serve MODEL SHA256 THREADS CONTEXT`) and the `openNativeSession` bridge in `session.mjs`. It verifies the executable and full model before readiness, retains the model/decoder within that process, and supports one request at a time. Requests provide the complete tokenized prompt. Only an exact extension of the already evaluated prefix reuses state; divergent or shorter prompts reset the decoder. The last generated token is not counted as cached until it has actually been evaluated. No other process or conversation receives this state.

Cancellation, unexpected protocol events and model-file changes retire the bridge session; callers must reopen it. An idle session closes after ten minutes by default. Nothing is exposed on a network port. Full model checks are performed again when a new session opens. Size/mtime checks detect ordinary model-file changes during a session; models must remain immutable while mapped, and this is not a defence against a malicious process rewriting files and restoring metadata. No disk trust cache was added.

Lite prefill processes up to sixteen tokens at a time, reusing each weight row across the batch and projecting vocabulary logits only after the final prompt token. The convolution and recurrent state still advance in causal order. Decode math is unchanged. Max retains sequential layer evaluation but skips vocabulary projection for every intermediate prompt token; the output head runs only for the final prompt token. Prompt progress is emitted during prefill for both architectures.

Native tests compare cached/uncached results for both architectures, divergent and shortened prompts, errors and batch boundaries; Node integration tests cover prefix reuse, concurrency rejection, cancellation, inactivity and file tampering. This developer worker has not replaced the app server or its activation/encrypted-model/desktop integrations.

The acceptance target for the next replacement PR is the app using Stellan-Run, with matched quality, latency, memory and CPU results against the shipped llama.cpp setup for **both** release models. Partial or synthetic results must not be described as that qualification.

## Current performance work

On a SHA-capable Linux x64 development CPU, hardware SHA-256 reduced full pinned Lite verification from median **13.03 s to 2.24 s** across three alternating trials per implementation. All six digests match the pinned hash. The implementation checks CPU capabilities before using SHA instructions and retains the portable fallback. This is model-verification timing, not a generation speedup over llama.cpp.

The persistent worker reused 34 evaluated tokens in a real Lite follow-up, processed 10 new tokens, and returned the same 12 generated IDs as a reset/fresh evaluation of that full follow-up. Warm prompt computation was 1.08 s versus 4.85 s for that fresh request. This is one cache diagnostic against our own fresh state, not a win over the baseline's existing prompt cache.

Packed Q4_K/Q6_K prefill now shares weight unpacking across four activation vectors. Lite traverses recurrent state channel-first across each microbatch to keep it hot, while preserving causal convolution and per-token state updates. Independent numerical fixtures cover both architectures, scalar/vector paths and chunk boundaries. Exploratory real-model timings still favour llama.cpp; see [the receipts and limits](EVIDENCE.md#sessions-and-hardware-verification).

To compare persistent Stellan-Run with your locally built pinned llama-server:

```sh
node experimental/stellan-runtime/bench-sessions.mjs \
  /path/to/stellan-runtime /path/to/llama-server \
  /path/to/model.gguf TRUSTED_MODEL_SHA256 /path/to/new-report.json 5
```

The output must be a new report file. Both use the same tokenized prompts, 8192 context, greedy output, 12-token limit and two CPU threads. The script runs engines sequentially to avoid simultaneous model residency, checks the model hash, retains executable hashes/raw output/timings, and does not download models, rent machines or start a hosted evaluation. Max is refused below 24 GiB reported RAM for this development diagnostic. Reference commit provenance must be checked separately; the executable hash alone does not establish its source commit. Grouped run order, two short prompts and CPU-only settings make this a diagnostic, not qualification for replacement.

## File inputs

After `npm ci` and `npm run build`, `run.mjs --capabilities` lists supported types. Add up to four `--file PATH` flags to the launcher. The shared app/runner processor reads text/code and extracts PDF/DOCX text locally, with byte/page limits, worker timeouts and explicit errors. For a formatted instruction prompt, end it at `[/INST]`; attachment text is inserted before that marker. Native inference still receives only text/token IDs. Images, scans without a text layer, audio and video are unsupported; see [the full input guide](../../docs/INPUTS.md).

## Lower-RAM Max cache

Max's attention cache is allocated in 256-token increments as it is used, and released on reset. It no longer allocates the full configured window during model construction. `state_bytes` reports allocated cache storage; `state_capacity_bytes` reports the configured data capacity. These are cache measurements, not total process RAM. Lite's recurrent state remains fixed-size.

FP16 is still the default reference path. `--kv-cache q8_0` opts into the experimental 8-bit Max cache through `run.mjs`; `openNativeSession` accepts `kvCache: 'q8_0'`. Native CLI experiments can set `STELLAN_RUNTIME_KV_Q8=1`. The 34-byte block stores 32 values plus an FP16 scale, versus 64 bytes for the same FP16 values: **46.875% less cache data** at the real Max head dimensions. At 8,192 tokens, the audited Max layout's data capacity is 1.25 GiB FP16 or 0.664 GiB Q8; this is arithmetic, not a measured full-Max RSS improvement.

The optional Q8 bridge supports an explicitly requested context up to 65,536 within the native 8 GiB cache-capacity budget. It does not enlarge the default 8,192 window or make Max's 14.3 GB weights fit in a small machine. Quantizing cached keys/values changes precision and may affect output. Numerical fixtures cover both modes; full-checkpoint quality and performance have not been validated here. Longer context also increases attention work. Keep the app's normal mode low-RAM and use its sidebar Long switch deliberately.

### Cache growth without whole-cache copies

Max now keeps separate 256-token cache allocations, so extending a conversation does not copy all previously cached keys/values. Reset still releases the cache. An isolated 65,536-position, one-cache stress test reduced median FP16 allocation/write time from 4.01 s to 0.13 s and peak process RSS from 257.0 MiB to 130.4 MiB. Q8 showed a similar reduction in temporary memory. This is a cache-only diagnostic, not a measured full-model speedup or RAM reduction; [raw measurements and reproduction](EVIDENCE.md#cache-growth-follow-up--23-november-2026) retain the limits. The persistent bridge now correctly forwards the requested Q8/FP16 mode to its native child.

### Head scheduling and rotating-order comparisons

Lite decode now splits independent recurrent heads across workers even when they share coefficient groups. Five rotating-order CPU rounds over two prompts reduced median decode time from **1,378.16 ms to 1,323.51 ms** versus our previous build, with identical generated IDs and essentially unchanged RAM. llama.cpp still led at 1,288.25 ms decode and 1,978.15 ms prompt versus our 2,288.43 ms prompt. These short Lite diagnostics do not qualify a production replacement; see [full receipts and limits](EVIDENCE.md#lite-head-scheduling--23-november-2026).

Prefer this comparison script over the older grouped-order probe:

```sh
node experimental/stellan-runtime/bench-paired.mjs \
  /path/to/candidate-stellan-runtime /path/to/pinned-llama-server \
  /path/to/model.gguf TRUSTED_MODEL_SHA256 /path/to/new-report.json \
  5 /path/to/previous-stellan-runtime
```

The previous native binary is optional. Each engine runs alone with rotating order, two CPU threads, 8,192 context and twelve greedy tokens over two prompts; independent prompts use no prefix reuse. Max compares explicitly selected Q8 caches and is refused below 24 GiB reported RAM. The script records hashes, partial results, CPU/RSS where available, exact output and timings. Source-commit provenance must still be verified separately. It neither downloads weights nor rents hardware, and a larger physical-device/agent test suite remains necessary.

Prefill now constructs immutable activation views once per batch and reuses each worker's result buffer instead of rebuilding them per matrix row. [Five further rotating-order rounds](evidence/lite-prefill-view-hoist.json) preserved all token IDs; the measured prompt difference was under 1%, so it is not a general speed claim.

### Less CPU work during prefill

A bounded 32-token microbatch and eight-vector Q4/Q6 tiles reduce repeated packed-weight work. On the longer matched-warmup diagnostic, prompt time fell about **19.8%** and request CPU time about **18.9% versus our previous engine**, with about **2.8 MiB** extra peak working memory. Weights are not expanded and the context budget does not grow. llama.cpp still leads on those longer prompts; [raw receipts and limits](EVIDENCE.md#bounded-32-token-prefill-and-eight-vector-tiles) retain both favorable and unfavorable results.

```sh
STELLAN_BENCH_WARMUP=1 node experimental/stellan-runtime/bench-paired.mjs \
  /path/to/candidate /path/to/pinned-llama-server /path/to/model.gguf TRUSTED_SHA256 \
  /path/to/new-report.json 5 /path/to/previous-native \
  experimental/stellan-runtime/bench/prompts-prefill.json
```

Use the equivalent environment setting on Windows. Warmup costs remain in the report. This diagnostic does not qualify a runtime replacement or measure full Max/GPU performance.

A further packed-Q6 experiment matched all 54 diagnostic responses but did not establish a useful end-to-end CPU saving; its best prefill-only trial differed by under 0.1% request CPU. The previous kernel is retained, with stronger extreme-value correctness fixtures. [Full trials and rejected variants](EVIDENCE.md#packed-q6-prefill-follow-up) remain recorded.

The separate native-host branch adds the first [C++ service-host prototype](NATIVE_HOST.md): verified persistent Lite text inference, status/reset/shutdown and raw token-byte streaming over private pipes without Node. It does not yet replace the app's authenticated web, approvals, files, tools or update services. Max text encoding, networking and full application parity remain work in progress. The host rests after ten quiet minutes (developer-configurable), releasing the model process; idle pipe reads are interrupt-responsive and bounded. Input is appended in slices, and oversized request buffers are released between requests.

The native-host prototype checks response writes and exits when its owner closes the output pipe, releasing the process even if stdin remains open. See [host lifecycle](NATIVE_HOST.md) for scope and validation.

ARM prefill batches now route each quantized input through the existing NEON Q4/Q6 integer kernel instead of the scalar floating-point fallback. Weights remain packed and no full-model expansion or larger context allocation is added. Existing independent matrix/model fixtures cover partial batches and scalar/accelerated correctness. The ARM CI job records five alternating fresh-process synthetic batch comparisons; those timings are not whole-model or agent performance claims. The four-platform desktop release still requires a real Lite tool exchange, including on Apple Silicon.


Release reliability follow-up: ARM kernels now read the process-fixed scalar override once per kernel path, avoiding repeated environment lookups in inner inference loops. No new whole-model speedup is claimed. Windows diagnostics showed an accurate read followed by untagged plain-text summaries, not established token truncation. Protocol recovery now explicitly requests both final-summary tags and continues to reject untagged output. The full desktop check uses the application's 2,048-token output allowance rather than a separate 256-token cap and saves each attempt, partial output and elapsed time on failure. It still requires an actual file read and a final summary containing the returned nonce; the 45-minute deadline is unchanged.


Lite tagged sessions now end naturally at a completed tool or done block, with thought-block handling and byte fallback. The bridge holds one final text fragment until native completion settles, preserving its worker rather than treating successful block completion as cancellation. Existing leading whitespace is preserved when the next prompt is formatted. Only exact evaluated prefixes are reused; user cancellation still retires partial state. This is completion detection, not grammar enforcement or automatic approval.

Lite tagged sessions additionally constrain each response root (and the root after a thought block) to a model-generated think/tool_call/done opening tag, preventing untagged plain answers. EOS is unavailable before a completed block. Tool JSON remains separately validated; this is not full GBNF grammar support. This targeted format constraint addresses repeated untagged Windows summaries in desktop45335948206; cross-platform real-model verification is still required.


ARM prefill tiling candidate: batches now share Q4/Q6 weight unpacking across up to eight activation vectors instead of invoking the single-vector NEON kernel for each token. Scratch remains bounded to small accumulators; no expanded weight copy, larger context, precision change or model architecture change is introduced. `STELLAN_RUNTIME_ARM_UNTILED=1` preserves the prior NEON batch path for paired diagnostics; scalar override remains available. ARM CI compares against that prior NEON path, not the much slower scalar path, and retains raw timings/checksums. Performance on real models and against llama.cpp remains unmeasured for this candidate.

Linux AArch64 CI45362512821 passed eight native groups. Its first five-pair comparison measured batch32 Q4 7.34331->5.23616ms (~1.40x), Q6 15.8093->8.03479ms (~1.97x), relative to prior NEON. The1-token tiled case was slightly slower, so single-vector batches/tails retain the existing single-vector kernel. These are component timings on Linux ARM, not MacBook or whole-model results; Apple Silicon validation remains required.
