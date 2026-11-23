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

SIGINT/SIGTERM stop active computation. The prototype does not yet multiplex cancellation while waiting on stdin or implement its own inactivity timer. Its owner should send `shutdown` or close stdin when idle, and use bounded process termination if unresponsive. Do not expose this developer protocol directly to a network.

The host intentionally has no file-edit/shell/tool endpoints and cannot approve actions. The next migration slices are native session management and authenticated local API/streaming, followed by context/notes, approvals and supervised tools, preserving all app security/activation/integrity behavior. It is not a replacement for those services yet, and it has no measured idle-RAM or total-app speed advantage.

Tests execute the actual C++ host from Python without invoking Node: text/ID parity, reset/status/shutdown, malformed UTF-8/hex and size limits, full-hash rejection and explicit Max ID mode. Existing native and Node bridge suites still test the shared core. A [real Lite smoke receipt](evidence/native-host-lite-smoke.json) matches the twelve generated IDs from the prior measured prompt; it is functionality evidence, not an agent benchmark or full-backend qualification.
