# Development evidence — 22 November 2026

This is an unfinished CPU experiment, not a release benchmark or proof of superiority. The engine remains off the production path.

## Real Lite execution

Downloaded the official pinned Lite GGUF and verified all 4,147,481,440 bytes against `84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e`. The independent engine generated this response to an instruction requesting a Python add function:

```python
def add(a, b):
    return a + b
```

The fast path emitted 14 tokens including EOS. The generated function's parsed syntax tree was checked for exactly the requested two arguments and addition return. This single demonstration is not a coding benchmark or an agent/tool-use test.

## CPU timing probe

A managed Linux x64 environment reported about 9.7 GiB RAM. GCC 14.2, Release build, two CPU threads, the same verified Lite weights, prompt IDs `[1, 23325]` (Hello with BOS), greedy sampling, three generated tokens and 8192 context. Reference: llama.cpp `cd959bae99ff4bed22bef2604f45241c09bbb8c8`, CPU only, required split-file patch applied, weight repacking disabled. The checked-in optional reference client batches prompt evaluation. It is a measurement client for the old engine, not a dependency of the new one.

Raw development receipt: [lite-cpu-probe.json](evidence/lite-cpu-probe.json). Its executable hashes identify the tested local development builds; this is not an attestation of a later commit or package.

| Observed metric | Candidate | Reference |
| --- | ---: | ---: |
| Prompt computation | 294.120 ms | 206.864 ms |
| Subsequent decode interval | 314.748 ms | 241.185 ms |
| CPU work during prompt/decode | 1045.100 ms | 885.401 ms |
| Whole-process peak RSS | 4,446,990,336 bytes | 4,446,212,096 bytes |
| Generated token IDs | 29493, 781, 781 | 29493, 781, 781 |

**The candidate did not win this comparison.** This is one very short paired observation, with different precision paths, on a virtual environment and a non-shipping CPU baseline configuration. Do not use these numbers in marketing or to justify a merge. Earlier sequential-prompt probes looked closer to parity; batching the reference prompt is a more realistic comparison and makes its advantage clearer.

Candidate model verification alone took about 18.37 seconds in this run and is excluded from the prompt/decode timings above. The prototype's software verifier and process-per-request bridge are startup bottlenecks. The receipt also retains wall-clock startup measurements; startup is not directly comparable here because verification occurs inside the candidate and outside the reference. Production comparisons must use matched verification, caching and loading behaviour.

The original scalar prototype needed roughly 8.58 seconds for this four-evaluation probe. Packed floating-point vector kernels reduced that to roughly 2.09 seconds; shared signed-8-bit activation kernels and hardware half conversion brought later probes into the sub-second range. These are improvements over our own prototype, not speedup claims over the shipped assistant. The candidate's quantized activation path can change logits and text, so quality evaluation remains mandatory.

## Max status

The pinned public Max header was inspected: 40 layers, width 5120, 32 query heads, 8 KV heads, head width 128, FFN width 32768, 131072 vocabulary, Q4_K and Q6_K matrices. Its transformer executor was checked through multiple positions/layers against an independently written Python numerical reference, including grouped attention, rotary positions, FP16 cached keys/values, residuals, normalization and SwiGLU.

Eight Unicode/code tokenizer examples using the actual Max vocabulary and merge metadata matched a local Hugging Face tokenizers 0.23.3 reference configured with the published Tekken pretokenization pattern. This reference package was only a local development tool; it is not a project or runtime dependency.

**Full Max checkpoint generation, coding quality, memory and speed are not verified here.** The host has less than 16 GiB RAM and the normal Max lock was retained. A small tensor fixture is not a substitute for full-weight validation.

## Reproduce and continue

The [Kaggle Run All notebook](kaggle-cpu-check.ipynb) builds both engines, verifies model downloads and runs five paired CPU probes for each model sequentially. Run it in a separate notebook after the owner's current benchmark finishes. It does not modify that existing notebook or run, and it does not push or release anything. It skips Max below 24 GiB reported RAM for this development check. Notebook code cells parse locally; the notebook has not been executed on Kaggle here.

The notebook compiles [tests/reference.cpp](tests/reference.cpp) against the pinned existing engine and its required patch. It uses [compare.mjs](compare.mjs) to alternate candidate/reference order and save token streams, CPU time, peak RSS, initialization and computation timings. It intentionally disables reference repacking to avoid an extra weight copy. Those CPU results remain diagnostic; final qualification must include shipped settings, normal GPU acceleration, physical machines, all supported context/history behaviours and full agent tasks.

For local checks, use the build/test commands in the README. `compare.mjs NATIVE REFERENCE MODEL SHA256 PROMPT [TOKENS] [REPEATS] [THREADS] [no-repack]` writes a JSON receipt to stdout and progress to stderr. Model integrity is checked before either engine runs. Comparison tools may contain model output; use synthetic/public tasks before sharing reports.

The next bottlenecks are persistent verified model processes, prompt-prefix state reuse, batched prefill, production integrity integration and GPU execution. Max needs a complete-checkpoint evaluation on sufficient RAM. Real Mac/Windows first-run behaviour and resource use, Metal/CUDA execution, encrypted model integration, secure serving and complete desktop packaging remain open.

No main replacement until both models pass the conditions in the handoff and the promotion evidence is independently inspected. A report's checkboxes or a passing fixture suite do not establish a security audit or a faster assistant.

## Verification optimization (22 November 2026)

The portable SHA-256 compressor now reads complete message blocks directly, keeps the eight round-state words in named values, and pads only the final one or two blocks. It still hashes every model byte and compares the complete digest before generation; no integrity cache or check bypass was added. No new dependency or inference arithmetic change.

Five alternating 32 MiB trials on the managed Linux x64 host gave median wall times of **148.4 ms before** and **105.7 ms after** (about 28.8% less time). Two alternating passes over the complete pinned Lite model (4,147,481,440 bytes) gave medians of **19.05 s before** and **12.12 s after** (about 36.4% less time). All full-file digests exactly matched the pinned release hash. The first baseline pass may include colder filesystem reads; these are small development samples, not USB, platform-wide or generation-speed claims.

[Raw verification receipt](evidence/verification-probe.json) retains executable hashes, all timings, model hash and probe conditions. Standard empty/abc/million-a vectors, every padding boundary through 129 bytes, and larger randomized buffers through 1 MiB plus padding boundaries match Python hashlib. Native core/scalar/GGUF/model fixtures and Node bridge checks pass locally. The optional actual-Max tokenizer test is skipped without its metadata fixture; full Max inference remains unverified on this host.

Local sanitizer execution uses AddressSanitizer and UndefinedBehaviorSanitizer. LeakSanitizer cannot start under this managed host's ptrace restrictions, so its local run requires `ASAN_OPTIONS=detect_leaks=0`; this is not a local leak-check result. The CI sanitizer configuration retains its default leak detection.

## Sessions and hardware verification

Stellan-Run now retains a verified mapped model and decoder across requests over private pipes. Exact-prefix reuse is bounded by the complete token sequence actually evaluated, excluding an unprocessed final generated token. Divergence resets state; aborts, protocol errors and file changes retire the bridge session. Default inactivity releases the process after ten minutes. These changes do not yet implement the production server, grammar constraints, activation, encrypted split files, cache save/restore, GPU execution or desktop packaging.

[Hardware SHA receipt](evidence/hardware-sha-verification.json): three alternating complete Lite hashes per implementation, warm filesystem cache, same pinned digest in every run. Median portable verification **13.032 s**, hardware-instruction verification **2.240 s**, about **82.8% less time** on this CPU. The hardware path requires SHA/SSSE3/SSE4.1 CPU support and falls back otherwise. Padding-boundary and randomized-buffer comparisons against Python hashlib, standard vectors and scalar fallback checks pass. ARM uses the portable verifier at present. This measures verification only.

[Real Lite prefix-cache receipt](evidence/lite-session-cache.json): a generated coding answer followed by a docstring request reused 34 evaluated tokens and read ten new tokens. Cached/fresh generated token IDs matched. Prompt times were **1076.91 ms cached** and **4851.47 ms fresh**, measured once within a persistent process after resetting it between the cases. This is a cache correctness/latency diagnostic, not a comparison with llama.cpp caching, an agent benchmark or a broad speed claim.

[Exploratory prefill receipts](evidence/lite-prefill-experiments.json) retain all recorded variants, including the initial batched Q4 regression. All six 12-token responses per variant matched the reference token IDs. Changes in system load and grouped baseline/candidate order limit comparisons between variants. The final exploratory mixed Q4/Q6 run still favoured the reference on prompt time and did not establish faster decode. Do not select only favourable samples or describe this as replacement qualification.

The reference executable was built from the project's pinned llama.cpp commit with its split-directory patch. Its Lite CPU flags include the app's no-repack, one-slot, 512/256 batching and one checkpoint. However, the diagnostic uses 8192 context, disables normal GPU acceleration, excludes the app verification pipeline from reference startup and uses only two synthetic coding prompts. It is not the complete shipped configuration. CPU/RSS and raw timing fields are retained; no unmeasured Max, physical-device or general superiority claim is made.

Max prefill now avoids intermediate output-head projections and normalizes attention scores once per head. Independent transformer fixtures check the resulting logits after multi-token prefill and subsequent decoding. Full Max-weight correctness, quality and speed remain unverified here. Local Release and AddressSanitizer/UndefinedBehaviorSanitizer suites pass; local leak detection remains disabled for the ptrace limitation described above, while CI retains normal leak checking. The optional actual-Max tokenizer golden test remains skipped without its model metadata fixture.

## Lazy and optional Q8 Max cache

Max no longer preallocates the entire attention window. Cache data grows in 256-token chunks, is released on reset, and reports allocated vector capacity separately from the configured maximum. Independent fixtures check FP16 behavior and the optional Q8 mode through prompt prefill and subsequent decoding. Randomized cache tests cover quantization error, full and partial rows, chunk growth, reset, invalid access and nonfinite input.

[KV-capacity arithmetic](evidence/kv-capacity.json) describes the audited 40-layer Max dimensions. Q8 stores 32 values in 34 bytes versus 64 FP16 bytes, a 46.875% cache-data reduction. This is not a full-Max RSS measurement or proof that long-context quality is unchanged. FP16 remains the reference default, and Q8 is opt-in. More context still increases attention work. Full Max weights and representative long tasks must be validated on sufficient RAM before promotion.

## Shared upload processor smoke test

The [real Lite upload smoke receipt](evidence/lite-upload-smoke.json) records a synthetic Python file passed through the shared document/text pipeline into Stellan-Run. The generated `add(a, b)` function returns `a + b`, checked by Python AST. The response also included explanatory prose despite the code-only instruction, so format adherence was not perfect. This is one functionality check, not a benchmark or pass@1 score. Verification checked the full pinned Lite file; no weights or private user files are in the receipt.

The persistent-session portability follow-up at `1d804a505dc71c857118540273924b95d5315d4d` passed Apple Silicon, Intel Mac, Linux, Windows and sanitizer CI. Fixture RAM mocking is restricted to tiny test models; the production RAM policies remain tested and enforced. Windows' read mapping denies writes to a running model, so that test checks the file lock and post-close hash refusal. Later changes require their own CI result.

## Cache growth follow-up — 23 November 2026

Max now retains separate 256-token allocations instead of allocating a larger contiguous buffer and copying all prior cache data at every growth boundary. Reset releases every chunk. Configured capacity and cached values are unchanged; a partial last chunk respects the context limit. `state_bytes` counts cache data allocations, excluding small chunk-container metadata. The persistent Node bridge also now passes its prepared environment to the child: `kvCache: 'q8_0'` actually selects Q8, and the default FP16 request overrides an inherited Q8 environment setting.

The [cache growth receipt](evidence/cache-growth.json) compares one 1,024-wide cache filled through 65,536 positions against `a98e743`, three repetitions with alternating before/after order. Both implementations retain the same data capacity and checksum. Median isolated results:

| Cache mode | Previous fill time | Chunked fill time | Previous peak RSS | Chunked peak RSS |
| --- | ---: | ---: | ---: | ---: |
| FP16 | 4,005.69 ms | 130.469 ms | 257.0 MiB | 130.4 MiB |
| Q8 | 2,079.27 ms | 167.86 ms | 137.2 MiB | 70.4 MiB |

These are allocation/write stress measurements for **one cache**, not full Max generation, all 80 caches, attention computation, model weights, a quality benchmark or a comparison against llama.cpp. Shared virtual-host timings and allocator retention limit generalization. Full model RSS is not halved by this change. Independent cache tests cover all positions across multiple chunk boundaries, partial rows/blocks, overwrites, skipped positions and reset. Transformer logits after crossing the first chunk boundary are checked against the independent Python reference in FP16 and Q8. Session tests check that the requested cache mode reaches the real native child.

To reproduce the cache-only workload, configure a Release build and run:

```sh
cmake --build experimental/stellan-runtime/build --target stellan-cache-bench --config Release
experimental/stellan-runtime/build/stellan-cache-bench f16
experimental/stellan-runtime/build/stellan-cache-bench q8
```

On Windows the executable is under `build/Release/`. The benchmark is excluded from normal builds; compile the same benchmark source against the earlier core for a before/after comparison, using its matching headers. Retain executable hashes and all trial outputs. No models or external services are needed.

A separate [VNNI Q4 experiment](evidence/rejected-vnni-probe.json) was **rejected**. Three rotating-order rounds over two short coding prompts produced identical generated token IDs, but median prompt/decode times were worse on this host: 2,397/1,415 ms versus 2,279/1,346 ms for `a98e743`. The experimental kernel is not retained. Those binary hashes identify an uncommitted development experiment, not the shipped candidate; these short Lite trials do not qualify a replacement engine.

## Lite head scheduling — 23 November 2026

Lite decode now distributes independent recurrent heads across workers instead of partitioning only shared coefficient groups. A one-group layer previously left this work on one worker even with multiple threads configured. B/C coefficients remain shared read-only; each head updates disjoint state. No additional recurrent-state allocation or arithmetic precision change is introduced. Prefill is unchanged.

The [complete rotating-order receipt](evidence/lite-head-split.json) contains five rounds, three engines and two prompts per engine: 30 twelve-token responses. All generated token IDs match. Engines run sequentially, with their starting order rotated each round. Native builds use GCC 14.2 Release; the reference is rebuilt from pinned llama.cpp `cd959bae99ff4bed22bef2604f45241c09bbb8c8` with the app's split-directory patch and CPU build flags. Same full pinned Lite weights, greedy prompts, two threads and 8,192 context:

| Engine | Median prompt time | Median decode time | Median request CPU time |
| --- | ---: | ---: | ---: |
| llama.cpp | 1,978.15 ms | 1,288.25 ms | 6,445.00 ms |
| Previous Stellan-Run (`bfaee2e`) | 2,280.32 ms | 1,378.16 ms | 6,939.25 ms |
| Head-scheduled Stellan-Run | 2,288.43 ms | 1,323.51 ms | 6,825.75 ms |

Decode takes about **4.0% less time than our previous version** in this diagnostic. Prompt computation is unchanged; the small observed difference is noise, not a prefill improvement. Native peak RSS is essentially unchanged at about 4.45 billion bytes. The reference reports about 4.74 billion bytes, but its checkpoint/production features differ; this is not feature-parity proof of a memory win. Reference CPU is measured through Linux process ticks; native CPU uses its request counters.

llama.cpp still leads on both prompt and decode medians. Shared virtual hardware, two short synthetic prompts, warm page cache, CPU-only execution and incomplete native production features prevent replacement qualification. Startup verification is not matched between engines. Matching short token streams is not an agent-quality benchmark or pass@1 score. Full Max weights were not run: they are absent and the host does not meet the 24 GiB diagnostic guard. Physical GPU/CPU devices and full Max/agent workloads still need testing.

The original `bench-sessions.mjs` is a historical grouped-order probe. Prefer the new `bench-paired.mjs`, which rotates independent engine sessions, records executable hashes and raw CPU/RSS/output/timings, saves partial reports on interruption and accepts an optional previous native binary. Its reports are diagnostics, not automatic promotion reports.

## Prefill view reuse follow-up

Immutable quantized activation views are now built once per batch rather than rebuilt for every output row, and each worker reuses its small result buffer. Five more rotating-order rounds retained all 30 matched token streams. [Raw receipt](evidence/lite-prefill-view-hoist.json): previous/candidate median prompt 2,270.00/2,249.43 ms, request CPU 6,887.41/6,734.97 ms. The sub-1% prompt difference is small relative to shared-host noise; this is removal of repeated setup, not proof of a broad speedup. llama.cpp still leads. No arithmetic, precision, context or production-engine choice changes.

## Bounded 32-token prefill and eight-vector tiles

Lite now uses a bounded 32-token microbatch and Q4_K/Q6_K kernels that share weight decoding across eight activation vectors, retaining smaller tails. The shared batch limit and scratch arrays are bounded; context and weight/activation precision are unchanged. No expanded copy of the model is retained. Independent Q4/Q6 fixtures cover batch sizes through 32, and the causal Mamba2 reference covers 15/16/17/31/32/33/63/64/65 tokens.

Two receipts retain all runs and executable hashes: [five short-prompt rounds](evidence/lite-batch32-short.json), and [three longer-prompt rounds with matched warmup](evidence/lite-batch32-warm-long.json). All 48 twelve-token responses match their comparison token IDs. The warmup is an identical one-token request per engine session, retained separately; it reduces the confound where native full-file hashing has already touched its mapping while the reference can fault pages on its first request. Neither probe is an agent-quality or pass@1 benchmark.

The longer public Python/JavaScript prompts are supplied in [the prompt file](bench/prompts-prefill.json). Warm inference medians:

| Engine | Prompt time | Request CPU time | Peak process RSS |
| --- | ---: | ---: | ---: |
| Pinned llama.cpp | 5,903.86 ms | 14,470.00 ms | 4,765,360,128 bytes |
| Previous Stellan-Run | 12,517.85 ms | 26,250.90 ms | 4,450,557,952 bytes |
| New Stellan-Run | 10,041.70 ms | 21,276.80 ms | 4,453,498,880 bytes |

Against our previous runtime, this is about **19.8% less prompt time and 18.9% less request CPU time**, with about **2.8 MiB** more bounded working scratch in the measured peak. The short probe reduced request CPU by about 10% with about 1.3 MiB extra RSS, but its unmatched startup warming prevents treating the short prompt-time advantage over the reference as a general win. Decode arithmetic is unchanged; decode timing differences can reflect state warmth/noise.

llama.cpp remains substantially faster and uses less CPU on the longer prompts. Its checkpoint/features differ, so the RSS difference is not feature-parity qualification. Shared virtual hardware, a small public suite, CPU-only execution, unmatched startup verification and no full Max-weight execution still prevent production replacement qualification. Keep normal context budgets low; these gains do not justify silently increasing the context window or claiming global superiority.

The comparison script accepts an optional prompt JSON file after the previous native binary (`-` omits that binary). Set `STELLAN_BENCH_WARMUP=1` for a recorded identical warmup; the default historical short probe remains available. Reports save warmup costs separately and retain partial results on interruption.


## Packed Q6 prefill follow-up

The tested batched Q6 candidate shifts quantized activations into unsigned bytes and shares the corresponding weighted bias across the activation tile. Weights remain signed -32..31; the largest paired product magnitude is 2*255*32=16,320, within int16. Accumulation and the bias correction use int32 before the original floating-point scales. This preserves quantization and handles even an explicit activation value of -128. No expanded weight copy or larger context is used. Independent two-block fixtures cover extreme weights, signed scales, activations -128/-127/127 and batch/tail sizes through 32, including the scalar fallback.

Two earlier layouts remain recorded. The [per-activation correction variant](evidence/lite-q6-input-correction-rejected.json) matched all 18 generated streams but increased median prompt time 9,828.27 → 10,248.08 ms and CPU 20,895.20 → 21,940.20 ms. It was rejected. The [shared-bias prefill-and-decode variant](evidence/lite-q6-shared-bias-mixed.json) reduced prompt time 10,484.80 → 10,100.68 ms, but decode rose 1,515.96 → 1,615.09 ms. It was also rejected as a combined change.

The final trial confined this packed calculation to batched prefill and restored the single-token quantized-dot function exactly from the previous checkpoint. Its results are below. None of these small CPU diagnostics is a model-quality, pass@1, GPU or complete-Max benchmark.

[Final prefill-only trial](evidence/lite-q6-prefill-only-rejected.json), three rotating-order rounds with matched warmup:

| Engine | Median prompt time | Median decode time | Median request CPU | Median peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Pinned llama.cpp | 6,149.41 ms | 1,377.04 ms | 15,005.00 ms | 4,765,329,408 bytes |
| Previous Stellan-Run | 10,143.81 ms | 1,553.11 ms | 21,676.15 ms | 4,453,550,080 bytes |
| Prefill-only candidate | 10,054.86 ms | 1,512.82 ms | 21,658.75 ms | 4,453,580,800 bytes |

The 0.88% prompt difference and 0.08% CPU difference are small relative to shared-host noise; peak RSS is essentially unchanged. Even the byte-identical decode function differed by about 2.6% in timing, illustrating that noise. The packed Q6 change is **not retained**: all prototype kernels are restored to the previous checkpoint. Keep the stronger independent extreme-value fixtures and all three receipts instead of claiming a speedup. All 54 twelve-token responses across these trials matched comparison IDs. llama.cpp still leads; these results do not qualify a production replacement.


## Natural tagged session completion

The [local real Lite receipt](evidence/lite-tagged-session.json) completed an actual read_file/tool_result/done exchange with one native worker. Its second request reused920 evaluated tokens and read only24 new prompt tokens (1,995.95ms prompt time). Both requests ended naturally at tagged boundaries. Existing cancellation still retires partial state. This is one Linux functional test, not a paired timing comparison or evidence that Stellan-Run now beats llama.cpp.
