# Native service host — first slice

Branch `feat/stellan-native-host` starts the portable-backend migration with a real C++ executable, `stellan-host`, linked directly to Stellan-Run. It loads and hashes the full model, keeps one decoder alive and serves private stdin/stdout requests. Node.js, llama.cpp and ggml are not needed to execute this inference-only path. This is a developer prototype; the portable app still uses its Node service and production engine.

Build the usual CMake project; `stellan-host` is a normal target and is installed alongside `stellan-runtime`. On Windows, use the Release directory and `.exe` suffix. Unicode executable/model paths use the existing wide-argument conversion.

```sh
stellan-host /path/to/lite.gguf TRUSTED_MODEL_SHA256 2 8192
```

After full verification it emits JSON `ready` with `native_host: true` and `input_mode: "utf8-hex"`. Each input line is either a control command or:

```text
REQUEST_ID MAX_TOKENS HEX_ENCODED_COMPLETE_UTF8_PROMPT
```

Use the complete formatted instruction/conversation prompt, not only an appended message. UTF-8 hex can represent newlines without breaking line framing. Text mode currently supports Lite SentencePiece, with a 1 MiB decoded-input limit and the native tokenizer's 32,768-token prompt limit; the configured context and output limits are also enforced. Max currently requires externally tokenized IDs and `--token-ids`, using the existing comma-separated token protocol. That limitation is explicit; the host does not silently use the wrong tokenizer.

Output is newline-delimited JSON: `prompt_progress`, `token`, `finished` or `error`, correlated by `request_id`. Token events include `id` and `bytes_hex`. Decode these bytes incrementally as UTF-8; a token can end midway through a Unicode character. Raw token-byte hex preserves those boundaries. Generation currently uses greedy sampling. Exact evaluated-prefix reuse, divergent-prompt reset, model-immutability checks and RAM/context guards are shared with the core worker.

Control commands, one per line:

- `status`: protocol version, inference-only scope, `node_required: false`, allocated state bytes and cached-token count.
- `reset`: forget recurrent/KV state and cached prompt; retain the verified mapped model.
- `shutdown`: emit `stopped` and close normally. Closing stdin also releases the process.

The host now exits after ten minutes without input, emitting `{"event":"rested","reason":"inactivity"}` and releasing the mapped model and decoder. `STELLAN_HOST_IDLE_SECONDS` accepts 1..86400 for developer experiments. Active generation is not an idle period. Its owner must reopen a fully verified host and resend the complete prompt after rest; this prototype does not persist a chat itself.

SIGINT/SIGTERM now stop idle POSIX pipe waits as well as active computation. POSIX uses a blocking poll with a bounded one-second timeout rather than a busy loop. Windows private pipes use availability checks and 100 ms sleeps; an overlapped pipe service remains future work. Windows requires redirected stdin/a pipe rather than an interactive console. CRLF and buffered commands remain supported. The owner can also send `shutdown` or close stdin, with bounded forced termination if needed. Do not expose this developer protocol directly to a network.

The host intentionally has no file-edit/shell/tool endpoints and cannot approve actions. The next migration slices are native session management and authenticated local API/streaming, followed by context/notes, approvals and supervised tools, preserving all app security/activation/integrity behavior. It is not a replacement for those services yet; a total-app resource or speed advantage has not been established.

Tests execute the actual C++ host from Python without invoking Node: text/ID parity, reset/status/shutdown, malformed UTF-8/hex and size limits, full-hash rejection and explicit Max ID mode. Existing native and Node bridge suites still test the shared core. A [real Lite smoke receipt](evidence/native-host-lite-smoke.json) matches the twelve generated IDs from the prior measured prompt; it is functionality evidence, not an agent benchmark or full-backend qualification.

Idle tests keep stdin open and verify automatic process exit, graceful POSIX idle termination, buffered CRLF controls and rejection of invalid timeout settings. These are lifecycle checks; OS-specific behavior and whole-app resource savings need their own measurements.

Input framing appends contiguous slices from its 4 KiB read buffer instead of extending the request one character at a time. Before waiting for the next request, line storage above 64 KiB is released, so one unusually large request does not retain that capacity for the session. The 4 MiB line limit remains. Tests cover read-buffer boundaries, an exactly-at-limit request, rejection above the limit and successful commands after malformed large input. No whole-app speed or RSS reduction is claimed from this change alone.

[Real Lite idle receipt](evidence/native-host-idle.json) retains three observations with a two-second test timeout, including one overlapping-build pilot. Each process exited and released its owned model/state; no CPU ticks were recorded during the one-second idle samples. That is below the coarse CPU measurement resolution, not literally zero CPU. Normal timeout remains ten minutes. Filesystem cache can remain reclaimable after exit, and Windows needs its own resource measurement.

The host also accepts `--split PATH SHA256`, preserving activation’s small decrypted first split and mapping the verified continuation directly. Both digests and the split tensor set are checked. ID-only regular workers avoid a redundant tokenizer lookup table; native-host byte output retains its own decoder. Full app service migration remains separate from this inference service.

The native host also treats a broken stdout pipe as a terminal error. If its owner closes the response channel while leaving stdin open, the host exits instead of retaining its mapped model or continuing to produce undeliverable output. POSIX can terminate through SIGPIPE; Windows uses checked iostream writes. A lifecycle test keeps the input pipe open while closing output and verifies termination after a status reply is attempted. This is a disconnect cleanup guarantee, not a throughput benchmark.
