# Third-party runtime licences

Generated offline by npm run licenses from package.json runtime dependencies and their installed transitive dependencies. No additional npm dependencies were introduced for cross-platform sandboxing. Node.js child_process/fs/path APIs implement process launching and path rules. Development tools, Node.js, Ollama, Linux bubblewrap, Apple sandbox-exec and Windows PowerShell/cmd/taskkill are separately supplied platform tools with their own licences; they are not bundled or relicensed here. Any optional copied shell runtime retains its original notices.

## Build tool: esbuild 0.28.2 (MIT)

Not shipped as a runtime dependency.

MIT License

Copyright (c) 2020 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## Desktop wrapper: Tauri 2.12.5 (MIT OR Apache-2.0)

https://github.com/tauri-apps/tauri . Copyright Tauri Programme within The Commons Conservancy. Direct Rust dependencies: tauri-build 2.7.4 (MIT OR Apache-2.0), serde and serde_json (MIT OR Apache-2.0), sha2 (MIT OR Apache-2.0), tempfile (MIT OR Apache-2.0). No new npm dependencies are added. Each native release must retain its generated Cargo.lock and run node scripts/native-licenses.mjs to gather the complete resolved Rust dependency licence texts. The stick builder requires that directory with --desktop-licenses. Missing texts fail generation and require upstream notice review; this source-only archive does not claim a completed binary redistribution audit. Platform webview libraries keep their own licences and are supplied by the OS. Tauri CLI 2.12.2 is a separate MIT OR Apache-2.0 build tool.

## Portable Node.js 24.22.1

Node.js is MIT with bundled third-party notices. The USB builder requires each supplied Node runtime's complete release LICENSE file and places it in LICENSES/Node-<platform>.txt. Any llama.cpp sidecar libraries require their corresponding redistribution notices. No runtime binaries are included in this source repository.

## Portable inference: llama.cpp v0.9.0 (MIT)

Portable binaries must be built from pinned upstream tag v0.9.0, https://github.com/ggml-org/llama.cpp/tree/v0.9.0 . Supplied binary provenance must be audited by the release builder; generated SHA256 checksums alone do not prove a source revision. Full upstream notice:

MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

