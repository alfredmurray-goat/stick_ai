<div align="center">

<img src="docs/hero.png" alt="The Stick AI workspace: a file tree on the left, a formatted answer with a code block in the middle, and live thinking and tool activity on the right" width="820">

# Stick AI

**A private coding assistant that runs entirely on your computer.**

Ask Stellan to explore, explain, fix or build code. It reads your files, plans the work, asks before it changes anything, and never sends your code or prompts anywhere. Everything runs from a USB stick or a folder on your computer.

[![macOS 13.5+](https://img.shields.io/badge/macOS-13.5%2B-000000?logo=apple&logoColor=white)](#install)
[![Windows 10+](https://img.shields.io/badge/Windows-10%2B-0078D4?logo=windows&logoColor=white)](#install)
[![Linux x64](https://img.shields.io/badge/Linux-x64-FCC624?logo=linux&logoColor=black)](#install)
[![Runs offline](https://img.shields.io/badge/inference-100%25%20offline-2EA44F)](#privacy)
[![HumanEval sample](https://img.shields.io/badge/HumanEval%20sample-Lite%2081%25-E2A07B)](#benchmarks)
[![Desktop builds](https://github.com/alfredmurray-goat/stick_ai/actions/workflows/desktop.yml/badge.svg)](https://github.com/alfredmurray-goat/stick_ai/actions/workflows/desktop.yml)
[![MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

</div>

## Features

- **Fully local.** Stellan runs on your own computer through a bundled llama.cpp server. No account, no cloud, no telemetry.
- **Two models, one flow.** Stellan-1 **Lite** explores your project and runs tools; Stellan-1 **Max** writes larger pieces of code when your computer has 16 GB or more. Use them together, Lite on its own, or Max directly.
- **You stay in control.** Every file change waits for your approval, shown as a red and green before-and-after diff. GitHub publishing waits for your review.
- **Watch it think.** Reasoning, file reads, searches and Lite → Max handoffs stream into a live activity panel as they happen.
- **Readable answers.** Replies render with headings, lists, tables and code blocks with a Copy button.
- **Fast follow-ups.** Stellan remembers the conversation between steps instead of re-reading it, so a follow-up step on a 4-core computer took about 5 seconds instead of about 95 in testing.
- **Apple Silicon GPU.** On M-series Macs, Lite runs on the GPU through Metal, and falls back to the CPU automatically if the GPU can't load it.
- **Bring your own models.** The model-free download is the same app with no model files inside. Point it at your own Lite and Max GGUFs and nothing is copied.
- **GitHub workspaces.** Connect a repository, ask for changes, review the diff and open a draft pull request, without touching your default branch.
- **MCP servers and skills.** Connect local or remote MCP tool servers and reusable SKILL.md workflows. Every MCP call asks first.
- **Signed app updates.** The app checks for signed updates and installs them without re-downloading your models.

<table>
  <tr>
    <td width="50%"><img src="docs/approval.png" alt="An approval card asking to save changes to greet.ts, showing the old line in red and the new line in green, with Allow changes and Keep my file buttons"></td>
    <td width="50%"><img src="docs/welcome-light.png" alt="The Stick AI welcome screen in light mode with an Open workspace button and three feature cards"></td>
  </tr>
  <tr>
    <td align="center"><b>Every change is yours to approve</b></td>
    <td align="center"><b>Light and dark, following your system</b></td>
  </tr>
</table>

## Benchmarks

Measured with the release Lite GGUF and the app's own llama.cpp server settings, CPU only, on a 4-core cloud machine.

| Benchmark | What it measures | Stellan-1 Lite |
| --- | --- | --- |
| **HumanEval, 21-problem sample** | Writing a Python function that passes hidden unit tests | **17 / 21 (81%)**, pass@1 |

- **How it was run.** One greedy attempt per problem (temperature 0), with every answer executed against HumanEval's official tests. The sample is every 8th problem of the 164 (`HumanEval/0, 8, 16, … 160`).
- **Read it as an estimate.** 21 problems is a small sample, so the 95% confidence interval is roughly **60% to 92%**. A full 164-problem run will replace this figure.
- **For context.** On the full set, Mistral's Codestral Mamba 7B reports [75.0%](https://huggingface.co/mistralai/Mamba-Codestral-7B-v0.1) and Qwen2.5-Coder-7B-Instruct reports [88.4%](https://arxiv.org/pdf/2409.12186). Those runs used different prompts and settings, so this isn't a strict head-to-head.
- **Max and agentic tasks.** Coding results for Max, and agentic results for Lite and Lite + Max on real multi-step tasks in the app, are being measured and will be added here.

**Speed in the real app.** The same two-message task (read two files, explain them, then read a third) took **850 s before** the prompt-cache change and **421 s after**, on the same machine. Writing an answer after a file read went from 172 s to 36 s.

## Download

Get Stick AI from [GitHub Releases](https://github.com/alfredmurray-goat/stick_ai/releases). Each release has two kinds of download.

| Download | What's inside | Size | Best for |
| --- | --- | --- | --- |
| **Complete** (`stick_ai-<platform>`) | The app, runtimes, Lite and Max | Large, split into parts | Plug-and-play on a fresh stick |
| **Model-free** (`stick_ai-<platform>-model-free`) | The app and runtimes, no model files | Small, one file | You already have the Stellan GGUFs |

| Platform | Open after extracting | You need |
| --- | --- | --- |
| Apple Silicon Mac | `Stick AI.app` | macOS 13.5+, 8 GB RAM |
| Intel Mac | `Stick AI.app` | macOS 13.5+, 8 GB RAM |
| Windows x64 | `Stick AI.exe` | Windows 10+, 8 GB RAM, Edge WebView2 |
| Linux x64 | `stick-ai` | glibc 2.35+, GTK 3, WebKitGTK 4.1, 8 GB RAM |

Max needs at least 16 GB RAM. Genuine Mac disk images (DMGs) are published as a separate **Stick AI — Mac DMGs** release.

> [!TIP]
> Complete downloads are split into parts because GitHub limits each file to 2 GB. Put every part and the **Join helper** for your platform in one folder, open the Join helper once, then extract the finished archive. The helper checks every part's checksum for you.

> [!NOTE]
> These are unsigned test builds. The first time you open one, macOS Gatekeeper or Windows SmartScreen may ask you to confirm. On a Mac, right-click the app and choose **Open**.

## Install

1. Download and extract the release for your platform, and keep the extracted folder together.
2. Open **Stick AI** (`Stick AI.app`, `Stick AI.exe` or `stick-ai`).
3. Click **Open workspace**. Stellan loads on your computer and the workspace opens.

No terminal, Node.js or Ollama is needed. `Start.command`, `Start.bat` and `start.sh` are technical fallbacks that open the same workspace in your browser.

### Model-free download

<p align="center">
  <img src="docs/model-free.png" alt="The welcome screen of a model-free download with a Choose your Lite GGUF button and a note that this download has no model files" width="820">
</p>

1. Open the app. The welcome screen shows **Choose your Lite GGUF**.
2. Pick your `stellan-1-lite` `.gguf` file. **Open workspace** unlocks.
3. Optionally, link Max under **Models & settings → Use a Max file already on your stick**.

Files are linked by path, never copied. Keep them outside the app folder, for example beside it on the same stick, and they keep working if you move the whole stick. If a linked file changes, the app asks you to choose it again.

## Using the workspace

- **Ask anything.** Type in the box at the bottom, or start from a suggestion such as *Explore this project* or *Find a bug*. Press ↵ to send and Shift ↵ for a new line.
- **Approve changes.** When Stellan wants to edit a file, an approval card shows the exact before-and-after lines. Click **Allow changes** or **Keep my file**.
- **Follow along.** The **Activity** panel streams Stellan's thinking and every tool it uses. **Stop** or Esc cancels at any time.
- **Edit files yourself.** Click a file in the sidebar to open it in **File preview**, edit it and save.
- **Use skills.** Type `/` to pick a skill, or manage them under **Skills**.
- **Switch appearance.** It follows your system's light or dark mode until you choose one.

## Privacy

- **Inference is offline.** Prompts, code and answers stay on your computer. The model server listens only on an authenticated local connection.
- **No telemetry.** There are no analytics or cloud fallbacks.
- **What does use the network.** The app checks GitHub for signed app updates (you can turn this off), GitHub workspaces talk to GitHub when you connect them, and remote MCP servers receive only the calls you approve.
- **Integrity checks.** Every app file is checked against a recorded SHA-256 before starting. A changed file is reported, not run.

## How it works

```mermaid
flowchart LR
    A["Desktop app"] --> B["Local workspace (authenticated loopback)"]
    B --> C["Agent loop"]
    C <-->|"streamed tagged protocol"| D["llama.cpp server · Stellan-1 Lite"]
    C -->|"tool calls"| E["Project files, search, edits"]
    E -.->|"changes wait for"| F["Your approval"]
    C -->|"delegate_code"| G["Stellan-1 Max writes code"]
    G -.->|"Lite reviews and applies"| C
```

- **Tagged protocol.** Lite replies in plain text with `<tool_call>{...}</tool_call>`, `<think>…</think>` and `<done>…</done>` tags, constrained by a grammar. The app runs one validated tool call per step and replies with `<tool_result>…</tool_result>`. Allowed tools: `list_dir`, `read_file`, `write_file`, `edit_file`, `search_files`, `run_shell`, `delegate_code`.
- **Lite and Max take turns.** In paired mode, only one model is loaded at a time. When Lite delegates, Max is started, writes the code, and Lite is restarted to review and apply it.
- **Prompt cache.** Lite keeps its conversation cache with one context checkpoint (about 0.3 GB), and old tool output is trimmed in large steps so the start of the conversation stays identical. Each step processes only new text.
- **GPU.** Apple Silicon builds include llama.cpp's Metal backend. Lite always uses the GPU there; Max uses it only with 24 GB or more, because macOS limits GPU memory to about two thirds of RAM. Set `STICK_GPU=0` to force the CPU.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `STICK_GPU` | on (Apple Silicon) | `0` keeps every model on the CPU. |
| `STICK_CONTEXT_MAX_BYTES` | `16384` | How much tool output and named-file context is sent per request (256 to 1048576). |
| `STICK_MODEL` | `stellan-1-lite` | Terminal model: `stellan-1-lite` or `stellan-1-max`. |
| `STICK_BASE_URL` | `http://localhost:11434` | Terminal model endpoint (`/v1/chat/completions`). Local addresses only unless `--allow-remote`. |
| `STICK_SHELL` | your shell | Shell for `run_shell`, for example `pwsh.exe` on Windows. |

## Terminal use

Stick AI also runs as a terminal assistant with your own Ollama models. Use Node.js 24.22.1 and npm.

```sh
npm install
npm run build
npm test
npm link
```

Prepare Stellan in Ollama by placing your verified `stellan-1-lite.gguf` and `stellan-1-max.gguf` in the `ollama/` folder, beside the Modelfiles:

```sh
ollama create stellan-1-lite -f ollama/Modelfile
ollama create stellan-1-max -f ollama/Modelfile.max
ollama serve
```

Then run from the project you want to edit:

```sh
stick doctor
stick chat
stick run "Inspect this repository and fix its failing tests"
```

<details>
<summary><b>More about terminal use</b></summary>

- Writes, edits and every shell command need your approval. `--yes` skips approval for that one run. Non-interactive runs deny changes unless `--yes` is given.
- `/exit` exits, `/clear` deletes the current history and `/history` shows it. Ctrl+C cancels the active request, approval or command and keeps the chat open. A cancelled one-shot run exits with status 1, and reaching the step limit exits with status 2.
- `.stick/config.json` holds `model`, `baseUrl` and `maxSteps` (1 to 1000). `STICK_MODEL` and `STICK_BASE_URL` override them. Only `localhost`, `127.0.0.1` and `::1` are accepted unless you pass `--allow-remote`, which sends prompts and tool results to that endpoint.
- Max is locked below 16 GiB of total RAM. `--force-max` overrides it for one run, with a warning that Max may be very slow or crash. `stick doctor` shows total memory and the lock status without loading a model.
- Files must be UTF-8 and at most 1 MiB. Search returns up to 200 matching lines and skips `.git`, `.stick` and `node_modules`. There is no execution or inactivity deadline; use Cancel or Ctrl+C.
- History is appended to `.stick/history.jsonl`, and one session per project is enforced with `.stick/session.lock`. History stores source contents in plain text, so keep `.stick` out of version control.

</details>

## Shell sandboxing

| Platform | Backend | Limits | Fallback |
| --- | --- | --- | --- |
| macOS | Apple `sandbox-exec` with a deny-by-default profile | Project read/write; system and developer tools read-only; no network | Restricted mode with a warning |
| Linux | bubblewrap with user, mount, PID and network namespaces | Project writable; toolchains read-only; no host network | Restricted mode with a warning |
| Windows | Restricted child process | Working-directory check and cleaned environment only. **No filesystem or network isolation.** | Always shows its warning |

Restricted mode does not confine arbitrary shell syntax: a command can use absolute paths, reach the network or change files outside the project. File tools still enforce their own path rules. Commands that a sandbox denies are never retried unsandboxed. Review every command you approve.

<details>
<summary><b>Sandbox details</b></summary>

- At startup the app probes the native sandbox with a fixed `exit 0` command and a three-second deadline. `stick doctor` prints the platform, backend, shell, working directory and any fallback warning. A successful probe is not a full confinement audit.
- POSIX commands use your `SHELL`. Windows uses `cmd` by default; choose PowerShell with `STICK_SHELL`. PowerShell receives the command as UTF-16LE encoded text, and cmd receives it with `/d /s /c`. Approval shows the JSON-encoded command, working directory and backend.
- The environment keeps `PATH` and essential Windows loader variables, removes inherited credentials and injection variables, and points home and temporary directories inside the project. Cancellation kills the process group (POSIX) or the process tree with `taskkill /T /F` (Windows). Reparented processes are outside that guarantee.
- File tools resolve real paths and reject traversal, absolute and drive-prefixed paths, escaping or dangling symlinks, special files and hard links. Windows drive and UNC boundaries, device names and alternate streams are checked.
- Do not run untrusted processes that rename directories or change mounts while file tools are working. Node.js path APIs can't give a race-free sandbox against a hostile local process.

</details>

## Troubleshooting

<details>
<summary><b>The app says the stick may be damaged</b></summary>

A file doesn't match its recorded checksum. Download a fresh copy and extract it again, keeping the whole folder together. In model-free copies, missing model files are expected and aren't reported as damage.

</details>

<details>
<summary><b>Open workspace is greyed out</b></summary>

This is a model-free download with no Lite linked yet. Click **Choose your Lite GGUF** and pick your Stellan-1 Lite `.gguf`. If the file moved or changed, choose it again.

</details>

<details>
<summary><b>The first answer takes a long time</b></summary>

The first message in a conversation has to be read in full, which can take a minute or more on a laptop CPU. Follow-up steps reuse that work and are much faster. Apple Silicon Macs use the GPU and are faster still. The activity panel shows live progress, and Stop cancels.

</details>

<details>
<summary><b>Max is unavailable</b></summary>

Max needs at least 16 GB of total RAM, and a Max GGUF that is bundled or linked. On a smaller computer, use Lite.

</details>

<details>
<summary><b>macOS sandbox-exec warnings</b></summary>

Apple marks `sandbox-exec` deprecated. Run `stick doctor` after macOS upgrades. If it's missing or unusable, the app uses restricted mode and warns before every command. Use a VM or container when you need enforced isolation.

</details>

<details>
<summary><b>Linux: bubblewrap missing or blocked</b></summary>

Install your distribution's `bubblewrap` package and run `stick doctor`. Containers, AppArmor or disabled user namespaces can stop it from starting; the probe reports why and falls back to restricted mode with a warning.

</details>

<details>
<summary><b>Windows: command warnings</b></summary>

The warning is expected. Windows commands run with your account's permissions because the app can't create a restricted token or Job Object. Only approve commands you trust, and prefer a VM for untrusted projects.

</details>

## Development

```sh
npm run check
npm test
npm run build
node dist/cli/index.js doctor
STICK_INTEGRATION=1 npm test -- tests/integration.test.ts
npm run licenses
```

CI runs type checks and the test suite on Ubuntu, macOS and Windows. The [Desktop builds](https://github.com/alfredmurray-goat/stick_ai/actions/workflows/desktop.yml) workflow builds all four platforms and runs a real Lite tool exchange on each before anything is published. Source lives in `src/cli`, `src/agent`, `src/tools`, `src/model`, `src/config`, `src/sandbox` and `src/portable`, with the desktop shell in `src-tauri` and the workspace UI in `portable/ui`.

More detail: [DESKTOP.md](docs/DESKTOP.md) (desktop app), [BUILDS.md](docs/BUILDS.md) (packages and releases), [PORTABLE.md](docs/PORTABLE.md) (USB browser launcher), [UPDATES.md](docs/UPDATES.md) (signed updates), [GITHUB_WORKSPACES.md](docs/GITHUB_WORKSPACES.md), [MCP_SKILLS.md](docs/MCP_SKILLS.md) and [VERIFICATION.md](docs/VERIFICATION.md) (what has and hasn't been verified).

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the pieces fit together, how to build and test, and how to open a pull request. AI coding agents should read [AGENTS.md](AGENTS.md), and [HANDOVER.md](HANDOVER.md) covers the current state of the project and what's next.

## Limits

- **Review what it writes.** Stellan can make mistakes. In stricter tests it mis-copied long random identifiers.
- **Lite's chat template.** The supplied Lite GGUF has no embedded template, so the app uses a tested Mistral-v1 formatter. The original training template is unverified.
- **Unsigned builds.** Gatekeeper, SmartScreen, clean-machine launch and physical USB performance still need manual checks.
- **Memory is total, not free.** The 8 GB and 16 GB thresholds use total RAM, which doesn't guarantee enough free memory for every task.

## Licences

- [LICENSE](LICENSE): MIT, copyright localilabs, for the Stick AI source.
- [NOTICE](NOTICE): the retained gpt-engineer MIT notice and Mistral AI base-model attribution. Stick AI is a TypeScript rewrite inspired by [gpt-engineer](https://github.com/gpt-engineer-org/gpt-engineer), with no reused Python code.
- [MODEL_LICENSE.md](MODEL_LICENSE.md): Stellan base model, LoRA provenance, dataset licences and outstanding provider-terms review.
- [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md): generated runtime dependency notices. Each package also includes llama.cpp, Node.js and desktop runtime notices.
