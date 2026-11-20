# Benchmarks

## Lite: HumanEval on a 4-core cloud machine

See the README. Run with `scripts/benchmark-humaneval.mjs` (all 164 problems, pass@1, greedy, each answer executed against the official tests) and the app's own llama.cpp settings.

## Max: HumanEval on a rented 32 GB machine

Max (14.3 GB) can't run on GitHub's free runners (16 GB): it keeps re-reading itself from disk. The **Max benchmark** workflow (`.github/workflows/max-benchmark.yml`) runs the same script on a machine you rent for a few hours, which joins GitHub as a one-job ("ephemeral") self-hosted runner with the `max-bench` label and deletes itself when done.

1. **GitHub runner token** (valid one hour): repository **Settings → Actions → Runners → New self-hosted runner → Linux**. Copy the token from the `./config.sh --url … --token XXXX` line.
2. **Hetzner API token**: Hetzner Console → your project → **Security → API tokens → Generate**, permission **Read & Write**. The server uses it only to delete itself at the end.
3. **Create the server**: **Add server** → location **Helsinki** or Falkenstein → image **Ubuntu 24.04** → type **Dedicated vCPU → CCX33** (8 vCPU, 32 GB) → keep **public IPv4** on (GitHub needs it) → paste [`benchmark/hetzner-cloud-init.yaml`](benchmark/hetzner-cloud-init.yaml) into **Cloud config** with the two tokens filled in → **Create & Buy now**.
4. Start **Actions → Max benchmark → Run workflow** (if it isn't already queued). The job waits until the runner appears.

The server installs the build tools, builds the pinned llama.cpp, downloads Max (checked against its SHA-256) and HumanEval, runs all 164 problems and uploads `humaneval-max.json` as a workflow artifact with a summary. Then the runner exits and the server deletes itself. The job stops after 14 hours and the server after 16 at the latest (about 1.76 kr an hour for a CCX33 including Danish VAT, so under 30 kr even then). Afterwards you can revoke the Hetzner API token.

The runner only takes one job and the repository is public, so start the workflow before or right after creating the server; the queued benchmark job is what it picks up.
