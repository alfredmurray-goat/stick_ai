# Portable USB release

The desktop app is the main entry point; open desktop/<platform> and double-click the app, then click Start. See [DESKTOP.md](DESKTOP.md) for the Tauri wrapper and release requirements. Start.command, Start.bat and start.sh remain technical browser fallbacks and intentionally open a terminal. Their status window must remain open. Linux file-manager execution varies.

This source repository is not a ready-to-run model distribution. No GGUFs, llama.cpp executables or Node runtimes were supplied. The builder refuses missing inputs. Test fixture executables and model headers are not usable runtimes and must never be shipped.

## Release inputs and build

Use Node.js 24.22.1 to build. `esbuild` 0.28.2 is an MIT development-only dependency; the resulting CommonJS bundles require no npm installation on the buyer's computer.

Supply all four self-contained, thin 64-bit llama-server binaries built from **llama.cpp v0.9.0**, the four matching Node.js 24.22.1 executables, the complete LICENSE file from each Node distribution, and both actual GGUFs. No assets are downloaded by the builder. Binary headers are checked, but headers and a self-generated checksum manifest do not prove source provenance, code signing, model compatibility, a correct quantization or complete dependencies. Audit and retain upstream build receipts separately. Follow MODEL_LICENSE.md before distributing weights.

```sh
npm install
npm run licenses
npm run build:stick -- \
  --macos-arm64 /assets/macos-arm64/llama-server \
  --macos-x64 /assets/macos-x64/llama-server \
  --windows-x64 /assets/windows-x64/llama-server.exe \
  --linux-x64 /assets/linux-x64/llama-server \
  --node-macos-arm64 /assets/node-macos-arm64/node \
  --node-macos-x64 /assets/node-macos-x64/node \
  --node-windows-x64 /assets/node-windows-x64/node.exe \
  --node-linux-x64 /assets/node-linux-x64/node \
  --node-license-macos-arm64 /assets/node-macos-arm64/LICENSE \
  --node-license-macos-x64 /assets/node-macos-x64/LICENSE \
  --node-license-windows-x64 /assets/node-windows-x64/LICENSE \
  --node-license-linux-x64 /assets/node-linux-x64/LICENSE \
  --desktop-macos-arm64 /assets/macos-arm64/StickAI.app \
  --desktop-macos-x64 /assets/macos-x64/StickAI.app \
  --desktop-windows-x64 /assets/windows-x64/stick-ai.exe \
  --desktop-linux-x64 /assets/linux-x64/stick-ai \
  --desktop-licenses /assets/desktop-licenses \
  --lite /assets/stellan-1-lite-q4_k_m.gguf \
  --max /assets/stellan-1-max-q4_k_m.gguf
```

The output is `dist/stick_ai_stick/`. `--out` overrides it; an existing output is never overwritten. `--support-macos-arm64`, `--support-macos-x64`, `--support-windows-x64` and `--support-linux-x64` optionally copy a directory of audited DLLs, dylibs, shared libraries and their licences next to the corresponding executable. Source links are dereferenced; output links are forbidden. Every sidecar is hashed. Static/self-contained builds are simplest; stock release archives may need sidecars. Use only redistributable CPU builds for this profile; GPU offload is explicitly zero to reduce driver cache writes and GPU requirements. The OS minimum and CPU instruction requirements are those of the supplied executables, not just their 64-bit header.

## Generated tree

| File/directory | Purpose |
| --- | --- |
| `Start.command`, `Start.bat`, `start.sh` | Technical fallback launchers |
| `desktop/<platform>/` | Main native desktop app for each platform |
| `README.txt` | Plain-English instructions, under 200 words |
| `bin/macos-arm64/llama-server`, `bin/macos-x64/llama-server` | Native Mac servers |
| `bin/windows-x64/llama-server.exe`, `bin/linux-x64/llama-server` | Windows and Linux servers |
| `bin/<platform>/node` or `node.exe` | Required portable Node runtime; no installed Node is used |
| `models/stellan-1-lite-q4_k_m.gguf` | Default Lite model, expected approximately 4.5 GB |
| `models/stellan-1-max-q4_k_m.gguf` | Max model, expected approximately 14 GB |
| `app/launcher.cjs`, `app/stick-verify.cjs`, `app/ui/` | Built JavaScript and local UI |
| `app/project/` | The buyer's editable project files |
| `LICENSES/` | MIT, Apache 2.0, upstream llama.cpp MIT, Node release licences, NOTICE, THIRD_PARTY_LICENSES and model provenance |
| `manifest.json` | Static-file SHA256 hashes, sizes, executable flags and pinned versions |
| `logs/launcher.log` | USB-only technical log |

These are the required layout's top-level entries, plus the requested manifest and log folder. Portable Node executables must exist under bin: JavaScript cannot run with no installed runtime otherwise. `Start.command` and `start.sh` are chmod 0755; use a distribution/copy method that preserves executable permissions and test the actual USB filesystem on macOS. FAT32 cannot hold these model sizes; use an appropriate large-file filesystem, with enough space for more than 18.5 GB of models plus runtimes and working files.

A full build requires both model inputs. A Lite-only shipment may deliberately omit the optional Max file after building: startup allows that one absent optional file, hides Max and disables delegation. The strict verification command still reports any missing file, including an intentionally omitted Max file.

## Integrity and local network boundary

The start scripts verify the Node and application bundle hashes with built-in OS hash tools before invoking them. The supervisor then hashes every listed static file, including all platform executables, sidecars and present models, before allowing model launch. Extra unlisted static files, links, wrong sizes, wrong hashes and unsafe mutable-directory links are refused. Hashing approximately 18.5 GB over a slow USB stick can take minutes; the progress indicator remains active. All launchers wait for model readiness until failure or cancellation, without a startup or inactivity deadline.

`manifest.json` cannot contain its own SHA256 without a circular dependency; it is the checksum index and trust anchor. It, the mutable log, buyer project files and narrowly named OS metadata (Finder metadata, AppleDouble, desktop/thumbnail indexes and OS trash/index folders) are excluded from static hashing. Unexpected application files and sidecar libraries remain errors. A modified manifest and start scripts can bless modified files: this is corruption detection against a trusted release, not digital signature verification. Distribute a trusted, signed release and keep manifest/signature receipts externally.

Model ports are selected only from 8080–8099 on 127.0.0.1. An occupied port is never reused. A random secret key, health response, authenticated model alias response, rejection of a deliberately wrong key and owned-child liveness are checked before prompts are sent. The same port and key are reused during swaps; a new listener taking that port causes refusal. Port handoff has a short cross-process race; the design is not protection against a malicious process already running as the same user that can inspect or replace owned processes/files.

The UI uses a separate ephemeral 127.0.0.1 port, a random session token, exact Host/Origin checks, no CORS grants, no remote assets, no cookies/local storage and no-store responses. The browser URL token is removed from the visible URL after load. Source and prompts go only to the verified local model endpoint. The portable UI disables run_shell on every platform: arbitrary commands could break the offline promise, especially on the Windows restricted backend. File tools stay inside app/project and write approvals are clickable. Terminal-mode shell behavior is unchanged.

## Lite orchestrates, Max codes

On 16 GiB or more with the optional Max file present, the default Lite session automatically offers Max through `delegate_code(task, context)`. Lite keeps planning, tool access, approvals, history and the decision to emit `<done>`. Max receives only the coding task and relevant source context. Its client is code-only: returned tool tags are data, never executed. Lite reviews and applies the result with its own file tool calls. Standalone Max remains a code-only choice and keeps the previous RAM lock; it has no tool executor.

The prompt requires delegation for new files, new functions and changes over about 20 lines. A conservative runtime gate also catches write_file requests and common function/large-edit patterns. This is not a complete parser for every language. Reading, searching, commands and small edits stay with Lite. There is no delegation call cap; every eligible request can reach Max. The configured agent step limit still bounds the overall task. Under 16 GiB the exact fallback is `Code specialist needs 16 GB RAM. Writing the code here instead.` `--no-swap` refuses delegation and lets Lite code directly.

The manager stops and waits for Lite to exit before starting Max. After the code request, it stops and waits for Max, then starts Lite. It never deliberately keeps two owned server processes loaded together. The application keeps the same conversation array and resends it to Lite; no server-local history is relied on. Failure also tries to restore Lite. Cancellation stops the active model without waiting for another load; the next terminal task reloads its selected model, and the browser can restart the assistant. Shutdown marks the manager as disposing, so a cancelled delegation cannot restart Lite after exit. Other model servers independently started by the user are not terminated.

All launchers allow initial loading, swap loading and code generation to run until completion, failure or cancellation. Short health and identity probes are retried without an overall readiness deadline. Process cleanup remains bounded after termination. Reusing the port avoids connection reconfiguration, not the cost of loading weights. The no-warmup option skips an empty generation pass, so health readiness can precede expensive first-token work; measure first-token latency as well as the health response. Approximately 18.5 GB / 500 MB/s is 37 seconds of reads before initialization; at 100 MB/s it is approximately 185 seconds. Caching, memory mapping, model shape, available memory and USB hardware change this considerably. A 14 GB Max plus 8192-token context and the OS may not fit comfortably in 16 GB, even one model at a time. Fast cold swaps and memory use must be measured with the actual models and release binaries; actual readiness and first-token times must be measured.

Terminal users can use the managed runtime with `stick chat --stick-root /path/to/stick` or `stick run "task" --stick-root /path/to/stick`; append `--no-swap` for debugging. Unmanaged Ollama mode preserves existing connectivity but refuses delegation because this app cannot safely unload or replace an independently managed model process through its chat endpoint. It does not silently start a second model in Ollama. The browser launcher needs no flags or typed commands.

## Lifecycle, browser and OS limits

The visible status process launches a detached supervisor over a private inherited IPC channel. The supervisor owns the HTTP UI and model child. Ctrl+C, normal exit, UI Stop, loss of the parent channel (including a closed status window) initiates cancellation, model-tree termination, HTTP shutdown and private temporary-directory removal. A browser disconnect does not end the session or interrupt active work; use Close assistant, quit the desktop app or stop the status process explicitly. POSIX process groups and Windows taskkill are used; native Windows console-close behavior and descendants must be tested. Cleanup errors go to the USB log and produce a plain message. Abrupt power loss, forced supervisor termination, unplugging during operation or OS denial can prevent cleanup; no application can guarantee deletion in those cases.

The technical browser fallback writes its logs only to the stick; the desktop app instead uses the OS application log folder. The fallback redirects its own model cache/home/temp settings to its private system temporary folder. Project changes stay on the stick. Browsers and the OS can still write history, cache, recent-file records, security/quarantine records, crash dumps, shader caches or virtual-memory swap outside this folder. Opening a normal browser cannot guarantee zero home-folder/registry/system writes. No private-browsing or forensic-erasure promise is made. This is a no-install application with local inference, not an amnesic operating system.

## Verification and qualification

```sh
npm run check
npm test
npm run build
npm run stick:dry-run
stick-verify /path/to/stick
```

The USB also contains app/stick-verify.cjs for maintainers to invoke with the bundled Node. Verification re-hashes static files, reports a failure in plain English and logs file details on the stick. Dry-run lists actions without creating a temporary directory, binding app/model ports, starting a model process or opening a browser. CI runs its planning command on macOS, Windows and Ubuntu, along with the unit and local mocked-browser tests.

Before shipping, qualify both Mac architectures, supported Windows x64 and Linux x64: code signing/notarization, Gatekeeper/quarantine prompts for all nested executables, executable bits on the actual drive, SmartScreen reputation, no administrator prompt, CPU instruction support, binary sidecars, browser opening, browser/terminal closure, disconnected IPC cleanup, temporary-file cleanup, removal of the drive, model chat template/protocol compatibility, out-of-memory behavior, occupied-port refusal, network interfaces, and cold/warm swap times. The README right-click/SmartScreen notes are guidance, not a way to bypass platform security. No hosted CI run or real-hardware qualification is claimed merely by providing this configuration.
