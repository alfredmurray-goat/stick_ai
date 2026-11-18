# Contributing to Stick AI

Thanks for helping out. Stick AI is a small project, so focused pull requests are the easiest to review and merge.

## How the project fits together

- **`src/`** is the TypeScript core, compiled to `dist/` with `tsc`:
  - `src/agent/` runs the agent loop: building context, trimming history and handing code to Max.
  - `src/model/` talks to the model server and parses the tagged protocol (`<tool_call>`, `<think>`, `<done>`).
  - `src/tools/` holds the file and shell tools the model can call.
  - `src/sandbox/` resolves safe paths and runs shell commands in the platform sandbox.
  - `src/config/` holds models, RAM thresholds and settings.
  - `src/cli/` is the `stick` terminal assistant.
  - `src/portable/` is everything the desktop app and USB package need: the local web server (`web.ts`), the managed llama.cpp engine (`engine.ts`), model linking (`local-models.ts`), integrity checks, packaging, signed updates, GitHub workspaces, MCP servers and skills.
- **`portable/ui/`** is the workspace you see: plain `index.html`, `main.js` and `style.css` with no build step. They load under a strict Content Security Policy, so there are no inline styles or scripts and nothing from the network.
- **`src-tauri/`** is the native desktop shell in Rust (Tauri 2). It starts the app, shows the file chooser and installs updates.
- **`scripts/`** build, smoke-test and publish releases.
- **`tests/`** holds the Vitest suite.
- **`docs/`** holds the guides and the images used in the README.
- **`ollama/`** holds the Modelfiles for running Stellan through Ollama from the terminal.

The UI and the server only talk over the local HTTP API in `src/portable/web.ts`. If you change one side of that contract, change the other side in the same pull request.

## Getting set up

You need Node.js 24.22.1 (see `.nvmrc`). For the desktop app you also need Rust, and on Linux the WebKitGTK development libraries.

```bash
git clone https://github.com/alfredmurray-goat/stick_ai.git
cd stick_ai
npm install
npm run build
```

## Running the tests

```bash
npm run check
npm test
```

On Linux, also check the native app compiles:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
cd src-tauri && cargo check
```

Both run automatically on every pull request, on Ubuntu, macOS and Windows.

## Trying changes by hand

Run the terminal assistant against a local Ollama model:

```bash
node dist/cli/index.js doctor
node dist/cli/index.js chat
```

To see the workspace UI, any static server works for layout checks. For the full app with a real model, build a package with `scripts/package-platform.ts`, as the desktop workflow does.

## Code style

- **TypeScript:** strict mode and ESM throughout. Keep functions small and names descriptive. Add a comment only to explain why something is done, not what it does.
- **UI:** build model output with DOM nodes and `textContent`, never `innerHTML`. Keep colours in the CSS custom properties at the top of `style.css`, and check both light and dark themes.
- **Screenshots:** when you change the UI, update the matching images in `docs/`.
- **Models:** never commit `.gguf` files. They're downloaded and checksum-verified by the build scripts.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep each pull request to one change.
3. In the description, say what changed and why in a sentence or two, and how you tested it. For UI changes, add a screenshot.
4. Make sure `npm run check` and `npm test` pass.

Merging app code into `main` starts the desktop builds, and a fully passing build publishes a release. See [AGENTS.md](AGENTS.md) for how that works.

## Reporting bugs

Open an issue using the bug report template. Please include your operating system and computer, the download you used (complete or model-free), and what you saw in `logs/launcher.log` inside the app folder.
