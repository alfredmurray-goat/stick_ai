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
