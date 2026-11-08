# stick_ai

## Download the Intel Mac Lite app

[Download the complete Intel Mac Lite build (4.15 GB)](https://github.com/alfredmurray-goat/stick_ai/actions/runs/42517759406/artifacts/13632203606).

Extract the download, then extract the ZIP inside it. Open the resulting folder, double-click **Stick AI.app** and click **Start**. Keep the folder together. No Node.js or Ollama installation is required. Requires **Intel macOS 13.5+** and **8 GiB RAM**. Lite is included; Max is not included.

This is an unsigned test build. Gatekeeper and clean first launch on the user's own Mac remain unverified. Review proposed changes: the model made accuracy errors in stricter identifier-copy tests. See [VERIFICATION.md](VERIFICATION.md) for measured checks and limitations. Download before **11 November 2026**; the artifact is retained for three days.


An offline desktop and terminal coding assistant by localilabs. It streams responses from Stellan-1 Lite or Stellan-1 Max through Ollama or the portable llama.cpp server, plans work, calls tools, reads results and continues until finished or the configured step limit is reached. It is a TypeScript rewrite inspired by [gpt-engineer](https://github.com/gpt-engineer-org/gpt-engineer), with no reused Python code.

## Desktop app

The desktop app is the main buyer entry point: open the app and click Start. No terminal, typed setup or installed Node/Ollama is needed when using a complete prepared stick on a supported computer with its system webview available. This repository is source plus release tooling, not a ready-to-run model distribution. See [DESKTOP.md](DESKTOP.md) for native builds, privacy limits, inactivity settings and hardware qualification. Start.command, Start.bat and start.sh remain technical browser fallbacks.

## Terminal installation

Use Node.js 24.22.1 LTS and npm. The engine, .nvmrc and CI are pinned to the exact Node version tested. Obtain the source repository, then run:

```sh
npm install
npm run build
npm test
npm link
```

Installation downloads development tooling; the installed assistant has zero npm runtime dependencies and requires no network apart from its configured model endpoint. There are no analytics, telemetry, update checks or cloud fallbacks in the assistant itself. Approved shell commands in restricted mode can access the network. Download dependencies and weights before working offline. This repository contains no model weights or claimed trained adapter.

## Prepare Stellan

Install Ollama separately. Supply your verified, merged Lite GGUF as `stellan-1-lite.gguf` beside `Modelfile`; optionally supply `stellan-1-max.gguf` for Max. Run:

```sh
ollama create stellan-1-lite -f Modelfile
ollama create stellan-1-max -f Modelfile.max
ollama serve
```

If Ollama already runs as a service, do not start a second server. Both Modelfiles import the respective GGUF tokenizer/chat template; a plain base GGUF does not become a fine-tune merely by renaming it. The weights must be trained for the tagged protocol below; the app does not request native OpenAI tool calling. Verify the real weights, chat template and Ollama version. Verify with the opt-in integration test. No template is fabricated here.

## Use

Run from the project you want to edit; that directory becomes the root:

```sh
stick init
stick doctor
stick
stick chat
stick run "Inspect this repository and fix its failing tests"
stick run "Create the requested project" --yes
```

Writes, exact edits and every shell command require terminal approval. `--yes` skips approval for that invocation only. Noninteractive invocations deny changes unless `--yes` is supplied. `/exit` exits, `/clear` deletes the current history and `/history` displays it. Ctrl+C cancels the active request, approval or command; the chat remains open. One-shot cancellation exits with status 1; a step limit exits with status 2.

`.stick/config.json` contains:

```json
{
  "model": "stellan-1-lite",
  "baseUrl": "http://localhost:11434",
  "maxSteps": 20
}
```

`STICK_MODEL` and `STICK_BASE_URL` override those fields. `maxSteps` accepts integers from 1 through 1000. The endpoint is always `/v1/chat/completions`; the base URL can optionally end in `/v1`. Only literal localhost, 127.0.0.1 and ::1 are accepted by default. Localhost is pinned to IPv4 loopback, redirects are refused, and credentials in URLs are rejected. `--allow-remote` explicitly opts into sending prompts and tool results to the configured remote model; that invocation is no longer offline. Use a local-only Ollama model, not an Ollama cloud-backed tag. stick_ai cannot inspect how an independently operated endpoint routes requests.

Thinking in `<think>...</think>` is separated and dimmed on a TTY even when tags cross streaming chunks. Tool arguments and compact results appear in the terminal. Tool output and file reads are bounded. Files must be UTF-8 and at most 1 MiB; search returns up to 200 matching lines and scans up to 10,000 entries, excluding `.git`, `.stick` and `node_modules`. Model calls abort only after 300 seconds without incoming bytes, configurable with STICK_IDLE_TIMEOUT_SECONDS; shell commands retain their sixty-second deadline. Automatic project context includes only a bounded file list and task-named files, configurable with STICK_CONTEXT_MAX_BYTES. Desktop thinking is collapsed behind Show thinking, with live progress and Cancel.

## Models and RAM lock

`stellan-1-lite` (Stellan-1 Lite) is the default. `stellan-1-max` (Stellan-1 Max) is the only other supported identifier. Interactive chat displays a numbered picker; press Enter to keep the configured model. Below 16 * 1024^3 bytes of total RAM, Max is disabled and grey on a TTY, with: `Stellan-1 Max needs 16GB RAM or more. Your Mac has X GB.` Non-TTY output retains the disabled text without ANSI colour. Lite is never RAM-locked; it is the intended 8GB option.

RAM is measured at startup with `os.totalmem()`. The threshold uses exact bytes, not the rounded display. It measures total RAM, not free RAM, GPU memory or an estimate of a particular quantization's requirements. Max is refused before making a model request even when selected through `.stick/config.json` or `STICK_MODEL`. `stick doctor` prints total bytes, displayed GB, Max lock/override status and whether the configured model is eligible. Doctor never loads a model.

Use `stick chat --force-max` or `stick run "task" --force-max` to override the Max lock for that invocation. This always prints a warning that Max may be very slow or crash. `--yes` does not bypass the RAM lock. Existing stored `stellan-1.0` configurations map to Lite for compatibility; an explicit obsolete or unknown `STICK_MODEL` value is rejected. Picker choices last for the current session; edit config or set STICK_MODEL to retain a preference.

## Tagged agent protocol

The training protocol is plain text inside the streamed chat response:

```text
<tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>
```

Allowed names, exactly: `list_dir`, `read_file`, `write_file`, `edit_file`, `search_files`, `run_shell`, `delegate_code`. The first complete call terminates that model step's stream. Later calls or summaries from that response are discarded. The agent executes at most that one validated call and then supplies the next user message as `<tool_result>result text</tool_result>`. Invalid JSON, unknown tool names, missing argument objects and tool failures produce an error in the same result wrapper so the model can recover. Unknown names are also printed to the terminal and never dispatched to a tool. Old native-call history is converted to text-only messages when sent to the model; new history uses only the tagged protocol.

Completion requires `<done>Final summary</done>`; only the summary inside the tags is printed as the final answer. An ordinary prose response without the required tags produces a recoverable protocol error instead of silently finishing. `<think>...</think>` is displayed separately and dimmed on a TTY; reasoning tags never appear in the visible answer. A tool call written inside a thought is not executed. Literal thinking tags inside tool JSON strings remain file content. OpenAI `tools`, `tool_choice`, tool roles and tool-call IDs are not sent to Ollama. The existing step limit also bounds malformed-response recovery.

## Platform support and shell isolation

At startup stick_ai detects `darwin`, `win32` or `linux`, selects a backend, and probes native sandbox startup with a fixed `exit 0` command and a three-second deadline. `stick doctor` prints the platform, selected backend, shell, canonical working directory and any fallback warning. A successful startup probe is not a full confinement audit. The test suite separately attempts an outside-project write when an enforcing backend is available.

| Platform | Preferred backend | Filesystem and network limits | Fallback |
| --- | --- | --- | --- |
| macOS | Apple `sandbox-exec`, generated deny-by-default profile | Project read/write; standard OS, Homebrew and developer-tool paths read-only; filesystem metadata readable. Network denied. `.stick` session state protected except `.stick/tmp`. `/dev/null` is writable for normal redirection. | Restricted mode with an explicit warning if the executable is absent or its capability probe fails. |
| Linux | bubblewrap with user, mount, PID and network namespaces | Project writable; standard runtime/toolchain directories read-only. Network namespace has no host network. `.stick` state is hidden except writable `.stick/tmp`. Minimal `/dev` and namespaced `/proc` are runtime exceptions. | Restricted mode with an explicit warning if bubblewrap is missing, user namespaces are blocked or the startup probe fails. |
| Windows | Restricted child process | Canonical working directory check and cleaned environment only. **No OS filesystem isolation, no network isolation, no restricted token or Job Object.** Commands retain your account permissions. | This is the baseline Windows backend; every approval displays its warning. |

Restricted mode on any platform does not confine arbitrary shell syntax. A command can change directory, use absolute paths, launch programs, contact a network or change files outside the root. The file tools still enforce their separate path rules. Do not treat a working directory or cleaned environment as a sandbox. `--yes` bypasses approval but does not suppress fallback warnings. Never retry a sandbox-denied command outside its sandbox automatically: backend selection happens at startup; ordinary command failures are returned to the agent.

POSIX commands use your `SHELL` (`zsh`/`bash`, with `sh` supported). Windows uses `ComSpec` (`cmd`) by default; select `powershell.exe` or `pwsh.exe` with `STICK_SHELL`. `STICK_SHELL` can also override the POSIX shell and accepts an absolute executable path or a shell name on PATH. Noninteractive profiles are disabled. PowerShell receives the exact command as UTF-16LE encoded text; cmd receives it with `/d /s /c`. Approval shows the lossless JSON-encoded command, canonical working directory and backend name.

The environment preserves PATH and essential Windows loader variables, removes inherited credentials and startup injection variables, and points HOME/USERPROFILE and temporary directories inside the project. POSIX shell timeouts and cancellation kill the detached process group. Windows uses the system `taskkill.exe /PID <pid> /T /F` to force termination of the active process and descendants. The command deadline is sixty seconds, with bounded cleanup time. Process-group escape, reparenting, already-exited Windows parents and permission boundaries can defeat process-tree cleanup in restricted mode; no native Job Object guarantee is claimed. Cleanup errors are reported. CI tests ordinary child-process timeout and cancellation on all three operating systems.

Linux now mounts installed system toolchains read-only instead of requiring a copied `.stick/runtime`. The previous `sandbox:prepare` script remains available for existing users, but its copied runtime is no longer required or selected by run_shell. Tools installed only in a home-directory version manager may be inaccessible in an enforcing sandbox; use a standard system installation or a toolchain inside the project. Builds that need to download dependencies must obtain them beforehand or be run manually outside the agent's enforcing sandbox.

## TROUBLESHOOTING

### macOS sandbox-exec deprecation

Apple marks `sandbox-exec` deprecated; it may disappear or change on a future OS release. Run `stick doctor` after OS upgrades. Missing or unusable sandbox-exec selects restricted mode and explicitly warns before commands. This fallback is functional but is not a replacement security boundary. Use an isolated VM/container when enforcement is required and sandbox-exec is unavailable. A tool rejected by the generated profile returns an error; it is not automatically rerun unrestricted. Some Xcode services, home-directory toolchains, keychains, signing operations and caches outside the project are intentionally unavailable. The profile grants only listed system read paths, project read/write, metadata access, logging lookup and normal process operations.

### Windows warnings and shells

The Windows warning is expected: this implementation uses no native addon and cannot create a restricted token or Job Object through Node's standard APIs. Only approve commands you trust. Prefer an isolated VM for untrusted projects. Set `STICK_SHELL` to the absolute PowerShell executable if cmd is not suitable. Keep `SystemRoot` valid so process-tree cleanup can find the system taskkill executable. Verify descendant termination on your Windows build, including background jobs; reparented processes are outside the claimed guarantee. Symlink tests require Windows Developer Mode or permission to create symbolic links; CI runners must provide that capability. Directory link fixtures use junctions on Windows.

### Missing or blocked bubblewrap on Linux

Install your distribution's bubblewrap package and run `stick doctor`. Presence alone is insufficient: containers, AppArmor and disabled unprivileged user namespaces may prevent it from starting. The bounded capability probe reports the reason and selects restricted mode with a warning instead of hanging or pretending isolation works. Administrator policy changes should be made deliberately by the machine owner. A restricted-mode test asserts the warning; it does not count as proof of confinement. The native test must successfully write inside the project, fail to write an external sentinel and leave that sentinel unchanged.

## History and safety boundaries

Conversation batches are appended to `.stick/history.jsonl`. Complete tool exchanges are persisted together, and an interrupted final JSONL record is repaired on resume. Cancellation after a completed write does not undo that write. A process crash between a tool effect and history persistence can leave an unrecorded effect; inspect the project before asking the agent to repeat changes. Writes use a same-directory temporary file, fsync and rename.

One session per project is enforced with `.stick/session.lock`. After a crash, remove the lock only after confirming no session is running. History stores source contents locally in plaintext: protect `.stick` and exclude it from version control. File tools canonicalize existing paths with realpath, canonicalize the closest existing ancestor for new paths, and reject traversal, absolute/drive-prefixed paths, escaping or dangling symlinks, special files and hard links. Internal symlinks are resolved to canonical project paths. Windows drive/UNC boundaries, device names, alternate streams and filesystem case policy are checked; `.stick` aliases remain reserved. Approval text strips terminal control sequences.

The project directory and runtime must be under your control. Do not run concurrent untrusted processes that rename ancestor directories or manipulate mounts while file tools operate: Node.js path APIs cannot provide a race-free directory-descriptor sandbox against a hostile local process. The shell namespace is a separate OS boundary, not a guarantee against kernel vulnerabilities. Review approved commands; they can delete or change project files. No automated model output should be treated as a security policy.

## Development and verification

```sh
npm run check
npm test
npm run build
node dist/cli/index.js doctor
STICK_INTEGRATION=1 npm test -- tests/integration.test.ts
npm run licenses
```

The original test scenarios remain, with tagged-protocol assertions and a Windows directory-link fixture adjustment. New tests cover Linux/macOS/Windows path fixtures, drives, UNC, case rules, internal and escaping symlinks, backend selection/probe failure, exact approvals and warnings, environment cleaning, shell arguments, host confinement or explicit fallback warnings, process-tree timeout and cancellation. `.github/workflows/ci.yml` runs these tests, TypeScript checks, the build, doctor and licence regeneration on Ubuntu, macOS and Windows with Node 24.22.1. The CI configuration is supplied; a real hosted matrix run is not claimed by a local test run. The integration test is skipped by default and also skips if Ollama cannot be reached; if a server responds with an invalid model or lacks tool calls it fails. It contacts only the configured local chat endpoint. A real Lite or eligible Max GGUF trained for the tagged protocol is required for this check. Additional unit tests cover the 8GB, 15.9GB and 16GB RAM thresholds, the exact byte boundary, force override, disabled picker, environment override, malformed JSON recovery, unknown names, first-call stream cancellation, done summaries and thinking separation.

Source layout: `src/cli`, `src/agent`, `src/tools`, `src/model`, `src/config` and `src/sandbox`. Strict TypeScript and ESM are used throughout. No code comments are included. Development tools are pinned directly; this source distribution does not include a dependency lockfile, so transitive development-tool versions can vary.

## Licences

- [LICENSE](LICENSE): MIT, copyright localilabs, for stick_ai source.
- [NOTICE](NOTICE): retained gpt-engineer MIT copyright/permission notice and Mistral AI base-model attribution.
- [MODEL_LICENSE.md](MODEL_LICENSE.md): Stellan base, LoRA provenance, dataset licences and outstanding provider-terms review.
- [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md): generated runtime dependency notices. `npm run licenses` walks installed runtime dependencies and their transitive dependencies offline and fails if licence texts are missing. Development tools and separately installed runtimes retain their own licences.

Model weights, datasets, Ollama, Node.js, bubblewrap and prepared shell-runtime binaries are not bundled or relicensed by stick_ai.

## No-install USB browser launcher and paired models

[PORTABLE.md](PORTABLE.md) documents the build inputs, exact output layout, local browser workflow, verification, lifecycle boundaries and hardware qualification. Use `npm run build:stick -- ...` with the four pinned llama.cpp executables, four Node runtimes and their licences, and both actual GGUF files. No fake models or executables are bundled in this source repository. The builder fails on missing inputs.

On eligible managed sessions, Lite orchestrates while Max codes through `delegate_code`. Only one owned model process runs at a time, using the same port. The five-call cap, under-16GB fallback and `--no-swap` bound delegation. Technical launchers retain 30-second per-load swap deadlines; the desktop app waits for activity with the configurable inactivity limit. Ordinary Ollama sessions remain supported; use `--stick-root` for lifecycle-managed delegation. Standalone Max is code-only, with no tool execution. The portable browser interface disables shell commands to preserve its offline behavior.

The prepared desktop release asks the buyer to click Start; the technical scripts open a terminal and browser. See DESKTOP.md for system-webview requirements. A normal browser and the operating system can still write their own caches, history and swap files; this app cannot promise a completely write-free host or deletion after power loss. Real weight compatibility, memory use, Gatekeeper, SmartScreen and USB swap performance remain release-qualification tasks.

## Intel Mac personal build

The Intel Mac app workflow assembles a macOS 13.5+ folder with Lite, portable Node and a CPU-only llama.cpp v0.9.0 server pinned to commit cd959bae99ff4bed22bef2604f45241c09bbb8c8. The old b5046 server cannot load the supplied Lite mamba2 architecture. Downloads are pinned to a model revision and SHA256. The supplied Lite GGUF lacks a chat template; this personal test build uses the Mistral-v1 formatter matching its [INST] tokenizer markers and refuses to publish a package unless the real model returns a tagged completion. The original training template remains unverified. Max is not bundled in this Lite-only Intel package. Unsigned apps remain subject to Gatekeeper.

Lite's managed server uses one slot, no duplicate CPU weight repacking, smaller processing batches and disabled RAM prompt caching. Its raw tagged responses are constrained to the training protocol rather than native function calling. The app still validates names and arguments independently. The compatibility formatter remains an explicit fallback because the supplied GGUF has no template metadata. Model accuracy is not guaranteed: repeated diagnostic tests exposed incorrect quoting of long random identifiers, so review proposed changes.
