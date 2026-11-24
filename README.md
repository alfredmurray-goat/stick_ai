<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.png">
  <img src="docs/brand/logo-light.png" alt="stick_ai" height="150">
</picture>

<img src="docs/hero.png" alt="The Stick AI workspace: a file tree on the left, a folded Thought for 4 s line above a formatted answer with a code block in the middle, and thinking and tool activity on the right" width="820">

# Stick AI

**A private coding assistant that runs entirely on your computer.**

Ask Stellan to explore, explain, fix or build code. It reads your files, plans the work, asks before it changes anything, and never sends your code or prompts anywhere. Everything runs from a USB stick or a folder on your computer.

[![macOS 13.5+](https://img.shields.io/badge/macOS-13.5%2B-000000?logo=apple&logoColor=white)](#install)
[![Windows 10+](https://img.shields.io/badge/Windows-10%2B-0078D4?logo=windows&logoColor=white)](#install)
[![Linux x64](https://img.shields.io/badge/Linux-x64-FCC624?logo=linux&logoColor=black)](#install)
[![Runs offline](https://img.shields.io/badge/inference-100%25%20offline-2EA44F)](#privacy)
[![HumanEval](https://img.shields.io/badge/HumanEval-Lite%2073.2%25%20%C2%B7%20Max%2080.5%25-7C4DFF)](#benchmarks)
[![Desktop builds](https://github.com/alfredmurray-goat/stick_ai/actions/workflows/desktop.yml/badge.svg)](https://github.com/alfredmurray-goat/stick_ai/actions/workflows/desktop.yml)
[![MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

</div>

## Features

- **Fully local.** Stellan runs on your own computer through our bundled Stellan-Run engine. No account, no cloud, no telemetry.
- **Two models, one flow.** Stellan-1 **Lite** explores your project and runs tools; Stellan-1 **Max** writes larger pieces of code. Lite + Max work together automatically with 24 GB of memory or more; on 16 GB you can still choose Max, with a warning that it may be very slow. Use them together, Lite on its own, or Max directly.
- **You stay in control.** Every file change waits for your approval, shown as a red and green before-and-after diff. GitHub publishing waits for your review.
- **Watch it think.** Stellan's thinking, file reads, searches and Lite → Max handoffs stream live in the conversation, then fold into a short "Thought for 12 s · 2 steps" line you can open again. The Activity panel shows the same in more detail.
- **Readable answers.** Replies render with headings, lists, tables and code blocks with syntax colours (JavaScript/TypeScript and other C-style languages, Python, shell, JSON, CSS, HTML, YAML/TOML and SQL) and a Copy button.
- **Prompt reuse.** Stellan-Run reuses exact evaluated prefixes between steps. Changed prefixes are reread; speed depends on the conversation and computer.
- **Our own runtime.** New desktop packages use Stellan-Run on the CPU. It is our independent C++ model engine, with bounded prefill buffers and lazy Max cache allocation.
- **Bring your own models.** The model-free download is the same app with no model files inside. Point it at your own Lite and Max GGUFs and nothing is copied.
- **GitHub workspaces.** Connect a repository, ask for changes, review the diff and open a draft pull request, without touching your default branch. Sign in with GitHub with a short code (no tokens to create), and choose exactly which repositories Stick AI may use.
- **Web search, built in.** Lite can look things up on the live web with [Actuent](https://actuent.ai): docs, versions, error messages, prices, events and news. It's free, needs no account, and every search shows you the exact words before anything goes online. Turn it off in Settings → MCP.
- **MCP servers and skills.** Connect local or remote MCP tool servers and reusable SKILL.md workflows. Every MCP call asks first.
- **Hooks.** Like Claude Code's hooks: run your own command, or notify another app on your computer, when you send a message, before or after Stellan uses a tool, when it needs your approval, or when it finishes. A hook can stop a message or tool call, or add notes for Stellan, but it can never approve anything for you. See [HOOKS.md](docs/HOOKS.md).
- **Signed app updates.** The app checks for signed updates and installs them without re-downloading your models.

<table>
  <tr>
    <td width="50%"><img src="docs/approval.png" alt="Stellan's live thinking and steps in the conversation, above an approval card asking to save changes to greet.ts with the old line in red, the new line in green, and Keep my file and Allow changes buttons"></td>
    <td width="50%"><img src="docs/welcome-light.png" alt="The Stick AI welcome screen in light mode with an Open workspace button and three feature cards"></td>
  </tr>
  <tr>
    <td align="center"><b>Every change is yours to approve</b></td>
    <td align="center"><b>Light and dark, following your system</b></td>
  </tr>
</table>

## Benchmarks

Measured with the release GGUFs and the llama.cpp benchmark harness: Lite on a 4-core CPU; Max with GPU offload enabled on Kaggle (4-core Xeon host, 31.3 GiB RAM).

| Benchmark | What it measures | Stellan-1 Lite | Stellan-1 Max |
| --- | --- | --- | --- |
| **HumanEval, all 164 problems** | Writing a Python function that passes hidden unit tests | **120 / 164 (73.2%)**, pass@1 | **132 / 164 (80.5%)**, pass@1 |

- **How it was run.** One greedy attempt per problem (temperature 0), with every answer executed against HumanEval's official tests. The 95% confidence interval is about **66% to 79%**.
- **Metric: pass@1.** Our run uses one greedy completion per problem, with no test-feedback repairs or best-of-N selection. Every comparison below has explicit pass@1 evidence in its primary evaluation documentation. “0-shot” describes prompt examples and does not establish pass@1. A pass@1 estimate averaged over independent samples is still single-sample success probability; it is not pass@100 or best-of-100.

  | Model | HumanEval pass@1 | Primary metric evidence |
  | --- | --- | --- |
  | GPT-4 Turbo (`gpt-4-1106-preview`, Nov 2023) | **83.7%** | [OpenAI results](https://github.com/openai/simple-evals#results), [scoring code](https://github.com/openai/simple-evals/blob/main/humaneval_eval.py): mean per-completion correctness, plus separate pass@k metrics |
  | **Stellan-1 Max** | **80.5% (132/164)** | One greedy attempt per problem; [raw results](docs/benchmark/results/humaneval-max.json) |
  | **Stellan-1 Lite** | **73.2% (120/164)** | One greedy attempt per problem |
  | Claude 2 (Jul 2023) | **71.2%** | [Anthropic model card, §4.3, p.10](https://assets.claude.com/bd2a28d2535bfb0494cc8e2a3bf135d2e7523226.pdf): “Codex P@1 (0-shot)”, temperature 1 |

  These are historical independent evaluations. Matching pass@1 does not equalize prompts, temperatures, code extraction, token budgets or test environments. Max is below the listed Turbo and Llama results. Other historical rows were removed pending explicit metric verification; that does not establish that their scores used best-of-N.
- **Max, completed run (22 November 2026).** **132/164 (80.5%)**, all task IDs present once; 32 failures retained. The supplied receipt records GPU offload (`gpuLayers: 999`), a 4-core Intel Xeon host and 31.3 GiB RAM. Median generation speed was **32.0 tokens/s** for this run; it is not a CPU or USB speed claim. The receipt does not record exact GPU devices or runtime/model hashes, so those cannot be independently reconstructed from it. [Raw results](docs/benchmark/results/humaneval-max.json). This supersedes the biased 26/30 partial CPU result. Harness failures remain failures; no score adjustment was made.
- **Next evaluation.** [SWE-bench Verified pilot](docs/benchmark/SWE_BENCH.md): a reproducible repository-patch baseline for Lite and Max, graded separately with the official harness. No SWE-bench result is claimed yet.


**Speed in the real app.** The same two-message task (read two files, explain them, then read a third) took **850 s before** the prompt-cache change and **421 s after**, on the same machine. Writing an answer after a file read went from 172 s to 36 s.

## Download

Stick AI ships preinstalled on a USB stick (launching February 2027 in the EU and May 2027 worldwide). Builds aren't public downloads: each release is kept as a **private draft** on [GitHub Releases](https://github.com/alfredmurray-goat/stick_ai/releases) that only people with write access to this repository can see, and is used to prepare the sticks. Sold sticks get app updates from a private, signed update host instead (see [docs/UPDATES.md](docs/UPDATES.md)). Each build produces **one** release, `Stick AI — all devices — build N`: a small `stick_ai-all-devices.zip` with the apps and the `stellan` folder (no models; the stick's own `stellan/models` are used), install helpers, checksums and the signed app updates. See **[docs/STICKS.md](docs/STICKS.md)** for how to make a stick.

One stick works on every supported computer: the three apps sit at the top of the stick and share one `stellan` folder with a single copy of Lite and Max (about 19 GB, so use a 32 GB stick formatted as exFAT).

| Computer | Open on the stick | You need |
| --- | --- | --- |
| Mac (Apple Silicon or Intel) | `Stick AI.app` (one universal app) | macOS 13.5+, 8 GB RAM |
| Windows x64 | `Stick AI.exe` | Windows 10+, 8 GB RAM, Edge WebView2 |
| Linux x64 | `stick-ai` | glibc 2.35+, GTK 3, WebKitGTK 4.1, 8 GB RAM |

Max works best with 24 GB of memory or more. On 16 GB you can still choose it (Settings → Models → Max directly), but the app warns first: there it keeps re-reading its 14.3 GB file from disk and a reply can take many minutes or seem stuck. On 16 GB the app uses Lite by default and never switches Max on by itself.

> [!TIP]
> Use the **Install on stick** helper from the zip rather than dragging folders: it merges onto the stick and never deletes `stellan/models`.

> [!NOTE]
> These are unsigned test builds. The first time you open one, macOS Gatekeeper or Windows SmartScreen may ask you to confirm. On a Mac, if it says the app can't be opened, go to **System Settings → Privacy & Security** and click **Open Anyway** (macOS 15 and later removed the old right-click → Open shortcut). On Windows, click **More info → Run anyway**. Apps run from an exFAT stick usually aren't flagged at all, because exFAT can't store the "downloaded from the internet" mark. [docs/FIRST_OPEN.md](docs/FIRST_OPEN.md) has the full steps and the printable card for the box.

## Install

1. Plug in the stick (or [make one](docs/STICKS.md)).
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

- **Welcome tour.** The first time the workspace opens, a four-step tour explains the models, approvals and where your project lives. Reopen it from Settings → Models. A printable quick-start leaflet for the box is in [`docs/packaging`](docs/packaging/quick-start-guide.pdf).
- **Ask anything.** Type in the box at the bottom, or start from a suggestion such as *Explore this project* or *Find a bug*. Press ↵ to send and Shift ↵ for a new line.
- **Approve changes.** When Stellan wants to edit a file, an approval card shows the exact before-and-after lines. Click **Allow changes** or **Keep my file**.
- **Follow along.** Under each message, a live line shows what Stellan is doing; click it to read its thinking and each step. The **Activity** panel has the full detail. **Stop** or Esc cancels at any time.
- **Resting.** After 10 quiet minutes the model is paused so it stops holding memory (about 4.5 GB for Lite), and the status says **Resting**. Your next message wakes it in a few seconds with the conversation intact.
- **Run tests.** Stellan can run a command such as your project's tests to check its own fixes. Each command shows an approval card first. On Mac and Linux it runs in the computer's sandbox (only the project folder can change, no internet); on Windows there is no sandbox, so the card warns that it runs with your permissions.
- **Edit files yourself.** Click a file in the sidebar to open it in **File preview**, edit it and save.
- **Use skills.** Type `/` to pick a skill, or manage them under **Skills**.
- **Switch appearance.** It follows your system's light or dark mode until you choose one.

<p align="center">
  <img src="docs/settings.png" alt="The Stick AI settings window with an app tile, a segmented Models, GitHub, MCP, Skills and Updates control, and grouped cards for linking Lite and Max files" width="820">
</p>

## Privacy

- **Inference is offline.** Prompts, code and answers stay on your computer. The model server listens only on an authenticated local connection.
- **No telemetry.** There are no analytics or cloud fallbacks.
- **What does use the network.** The app checks GitHub for signed app updates (you can turn this off), GitHub workspaces talk to GitHub when you connect them, web search sends only the search words or page address you approve to Actuent (never your code or files), and remote MCP servers receive only the calls you approve.
- **One switch for all of it.** **Settings → Models → Allow internet** is on by default. Turn it off and nothing leaves the computer: no web search, GitHub, remote MCP servers, hooks that notify other computers or automatic update checks. Stellan works exactly the same, because it never needed the internet. (Activating a new stick with its printed code goes online once either way.)
- **Almost nothing on your computer.** Everything stays on the stick. The app needs about **300 MB free** on the computer (for a temporary folder it deletes when you quit) and uses up to about 1.5 GB more, if there's room, for caches that make new conversations start faster. The window warns you when space is low.
- **Locked models.** On sold sticks the models only work after activation (see [docs/ACTIVATION.md](docs/ACTIVATION.md#locked-models)).
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

- **Tagged protocol.** Lite replies in plain text with `<tool_call>{...}</tool_call>`, `<think>…</think>` and `<done>…</done>` tags. Stellan-Run currently validates the completed response rather than enforcing a token grammar. The app runs one validated tool call per step and replies with `<tool_result>…</tool_result>`. Allowed tools: `list_dir`, `read_file`, `write_file`, `edit_file`, `search_files`, `run_shell`, `delegate_code`.
- **Lite and Max take turns.** In paired mode, only one model is loaded at a time. When Lite delegates, Max is started, writes the code, and Lite is restarted to review and apply it.
- **Stable history.** Old tool output is trimmed in large steps to preserve unchanged prefixes. Stellan-Run reuses only the prefix it has actually evaluated; it does not claim rollback snapshots.
- **Stable instructions.** The system message remains unchanged within a session; project files and skill guidance travel with the task. Stellan-Run can pre-read a prefix, but saved rollback snapshots are not available.
- **Nothing runs when idle.** The window waits for the app to report a change instead of asking twice a second, and the model rests after 10 quiet minutes (`STICK_REST_MINUTES` changes this; `0` turns it off).
- **Context controls in the sidebar.** Normal keeps Lite at 65,536 tokens and Max at 8,192 to favor RAM headroom. Long raises Lite to 262,144 and Max to 16,384 / 32,768 / 65,536 according to available RAM, with potentially slower replies. Lite uses fixed-size recurrent state; Max's attention cache grows with context. See [context and chat memory](docs/CONTEXT_MEMORY.md).
- **Long context mode.** Sidebar → Long context: Lite 262,144 tokens, Max up to 65,536, and about 100k tokens of conversation kept word for word. A clear warning says it can be much slower on an ordinary laptop when a long conversation has to be read again; switching restarts the model.
- **Smart compaction.** When a new task starts and the conversation is over its budget, older tasks become a short summary (what you asked, which files and tools were used, what Stellan answered) and the newest stay word for word. It is built from the conversation itself, so it takes no time and invents nothing.
- **Stellan-Run.** New desktop packages execute our C++ runtime. The authenticated streaming adapter shares the existing app backend process, avoiding another Node process. The binary reads verified model splits directly.
- **Prompt reuse.** Exact evaluated prefixes are reused. Changed prefixes and model swaps are re-read; on-disk slot snapshots are currently unavailable.
- **CPU and memory.** Inference uses two CPU workers, mapped quantized weights, bounded 32-token Lite prefill and lazily allocated Q8 Max caches. GPU offload, speculative decoding and token-level grammar constraints are currently unavailable. Tool responses still pass the strict parser and every changing action still needs approval.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `STICK_GPU` | legacy packages only | Stellan-Run currently uses the CPU. |
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
- Max is locked on computers with less than 16 GB (below 15 GiB of total RAM reported, to allow for memory the firmware and graphics keep). From 16 GB it can be chosen, with a warning below 24 GB (22 GiB reported) that it may be very slow. `--force-max` overrides the lock for one run, with a warning that Max may be very slow or crash. `stick doctor` shows total memory and the lock status without loading a model.
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
<summary><b>Open workspace does nothing, or asks for a Lite file</b></summary>

This is a model-free download with no Lite linked yet. Click **Open workspace** or **Choose your Lite GGUF** and pick your Stellan-1 Lite `.gguf`. If the file moved or changed, choose it again. The `.gguf` needs about 4.1 GB of free space wherever you keep it.

</details>

<details>
<summary><b>On a Mac, the assistant won't start</b></summary>

The first time, if macOS refuses, open **System Settings → Privacy & Security** and click **Open Anyway**. A zip downloaded in a browser marks every file inside as "from the internet", and macOS refuses to run the bundled model server until that mark is cleared. From this version the app clears it itself, but only for its own runtimes after checking their checksums. With an older copy, run this once in Terminal, dragging the **Stick AI** folder in for the path:

```bash
xattr -dr com.apple.quarantine "/path/to/Stick AI"
```

The app's logs are in `~/Library/Logs/build.localilabs.stickai/`.

</details>

<details>
<summary><b>The first answer takes a long time</b></summary>

The first message in a conversation has to be read in full, which can take a minute or more on a laptop CPU. Follow-up steps reuse that work and are much faster. Stellan-Run currently uses the CPU on every platform. The activity panel shows live progress, and Stop cancels.

</details>

<details>
<summary><b>Max is unavailable</b></summary>

Max needs at least 16 GB of memory (24 GB recommended) and a Max GGUF that is bundled or linked. On 16 GB it can be very slow, so the app warns first; on less, use Lite.

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

More detail: [DESKTOP.md](docs/DESKTOP.md) (desktop app), [BUILDS.md](docs/BUILDS.md) (packages and releases), [PORTABLE.md](docs/PORTABLE.md) (USB browser launcher), [UPDATES.md](docs/UPDATES.md) (signed updates), [GITHUB_WORKSPACES.md](docs/GITHUB_WORKSPACES.md), [MCP_SKILLS.md](docs/MCP_SKILLS.md), [HOOKS.md](docs/HOOKS.md), [ACTIVATION.md](docs/ACTIVATION.md) and [VERIFICATION.md](docs/VERIFICATION.md) (what has and hasn't been verified).

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the pieces fit together, how to build and test, and how to open a pull request. AI coding agents should read [AGENTS.md](AGENTS.md), and [HANDOVER.md](HANDOVER.md) covers the current state of the project and what's next.

## Limits

- **Review what it writes.** Stellan can make mistakes. In stricter tests it mis-copied long random identifiers.
- **Lite's chat template.** The supplied Lite GGUF has no embedded template, so the app uses a tested Mistral-v1 formatter. The original training template is unverified.
- **Unsigned builds.** Gatekeeper, SmartScreen, clean-machine launch and physical USB performance still need manual checks.
- **Memory is total, not free.** The 8 GB, 16 GB and 24 GB app thresholds use total RAM (checked as 7, 15 and 22 GiB, because computers report a little less than they're sold with), which doesn't guarantee enough free memory for every task. Stellan-Run also accepts the 7 GiB floor for Lite; its separate Max runtime guard remains in place.

## Licences

- [LICENSE](LICENSE): MIT, copyright localilabs, for the Stick AI source.
- [NOTICE](NOTICE): the retained gpt-engineer MIT notice and Mistral AI base-model attribution. Stick AI is a TypeScript rewrite inspired by [gpt-engineer](https://github.com/gpt-engineer-org/gpt-engineer), with no reused Python code.
- [MODEL_LICENSE.md](MODEL_LICENSE.md): Stellan base model, LoRA provenance, dataset licences and outstanding provider-terms review.
- [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md): generated runtime dependency notices. Packages include Stellan-Run, Node.js and desktop runtime notices; historical/optional components retain their credits.

### File inputs

Attach text, code, CSV/JSON, PDFs with a text layer, and DOCX documents in the workspace. Files are converted locally to text; Lite and Max do not natively interpret images, scanned pages, audio or video. Stellan-Run's launcher uses the same input processor through `--file`. See [supported inputs and limits](docs/INPUTS.md).

The sidebar context wheel shows the local server's last reported usage, with a **Long context** switch for larger, slower tasks. Normal favors lower RAM. Each chat can keep bounded local memory notes across restarts; saving, viewing and forgetting notes are beside the context controls. See [context and chat memory](docs/CONTEXT_MEMORY.md).

The shared [project plan](docs/PROJECT_PLAN.md) records Stellan-Run, the unified unnamed benchmark/learning project, our own core-component direction, and the low-RAM/sidebar context defaults.

Stellan-Run development now avoids whole-cache copies during Max cache growth and correctly forwards the persistent-session cache mode. [Isolated cache measurements](experimental/stellan-runtime/EVIDENCE.md#cache-growth-follow-up--23-november-2026) show lower temporary RAM and allocation time; full-model superiority has not been established. By the owner’s choice, new desktop releases now use Stellan-Run even while qualification continues. Older installed packages keep their previous engine until updated.

See the [own-component roadmap](docs/OWN_COMPONENTS.md) for proposed replacements beyond inference, ranked by useful product gains and compatibility work.

### Stellan-Run release transition

Desktop v0.2.0 packages use Stellan-Run by default, including activated locked models. Lite completed a real read-file/tool-result/done exchange through the authenticated app API. Full Max-weight execution and physical GPU/device qualification remain outstanding; CPU tests still favor llama.cpp on the recorded longer prompts. Historical HumanEval scores were measured with the earlier llama.cpp harness and have not been remeasured on Stellan-Run. See [runtime integration and limits](docs/STELLAN_RUN.md). The legacy filename alias and `llamaRelease` manifest field exist only so older installed updaters can accept the migration; the new release builds its engine from our source.

Our [original MCP client](docs/MCP_CLIENT.md) includes bounded protocol-envelope and tool-client initialization validation in our existing request/transport code. Its stdio reader avoids repeated partial-message copies and releases large buffers; pending requests have count and payload budgets. Server replies share the outgoing payload budget, so stalled writes cannot build an unbounded ping-response queue. The RPC core bundles independently of SDK/schema runtimes; whole-app SDK removal is still in progress. SDK transports and operation schemas remain until compatibility is complete.

Stellan-Link is our original tool-only MCP client, including stdio, streamable HTTP, legacy SSE and bounded tool-result validation. The upstream MCP SDK is used only for development-time comparison tests and is absent from the production bundle. See [MCP connections](docs/MCP_SKILLS.md).
