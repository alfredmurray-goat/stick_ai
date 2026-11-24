# Reused Lite activation buffers

Lite now fills reusable quantized activation buffers for each matrix multiplication instead of allocating new vectors in every layer. Quantization arithmetic, rounding, group sums, packed weights and output selection are unchanged. The existing return-by-value API remains available for other callers.

Single-token decoding retains one vector sized for the largest input seen by that decoder. Prefill retains at most 32 vectors while it processes layers and chunks, then releases their allocations before interactive decoding resumes, including on exceptions. There is no process-global cache and no larger default context window. Model unload destroys the decoder and its remaining scratch.

Native tests check exact activation values, sums and scales across changing dimensions, zero inputs and reused storage. The existing scalar/vector numerical, complete model-fixture, session and host tests still apply. This removes repeated heap allocations; it is not evidence of a whole-model speedup or superiority over llama.cpp. Matched real-model latency and memory measurements are still required.

The worker executor also runs single-threaded, empty and single-row jobs directly under its existing submission lock. It leaves sleeping workers asleep and avoids publishing a job/condition-variable round trip when parallelism cannot help. Tests cover empty/single-row ranges, exception recovery and subsequent parallel work. This is a dispatch-overhead reduction, not a measured end-to-end model speed claim.
