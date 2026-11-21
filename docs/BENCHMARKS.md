# Benchmarks

## Lite: HumanEval on a 4-core cloud machine

See the README. Run with `scripts/benchmark-humaneval.mjs` (all 164 problems, pass@1, greedy, each answer executed against the official tests) and the app's own llama.cpp settings.

## Max: HumanEval on a rented 32 GB machine

Max (14.3 GB) can't run on GitHub's free runners (16 GB): it keeps re-reading itself from disk. The **Max benchmark** workflow (`.github/workflows/max-benchmark.yml`) runs the same script on a machine you rent for a few hours, which joins GitHub as a one-job ("ephemeral") self-hosted runner with the `max-bench` label and deletes itself when done.

**Free, no card: Kaggle.** Kaggle's free notebooks have about 30 GB of memory and 4 CPU cores for up to 12 hours. Import [`benchmark/kaggle-max-humaneval.ipynb`](benchmark/kaggle-max-humaneval.ipynb) (**File → Import Notebook**), turn **Internet** on (needs a verified phone number), keep the accelerator on **None**, then **Save Version → Save & Run All**. It runs the same script, pinned llama.cpp, pinned Max and HumanEval as the workflow below, and prints `RESULT: n/164` at the end; `humaneval-max.json` is under **Output**. Set `SAMPLE=4` in the cell for a quicker run of every 4th problem.

**Or rent a machine** that joins GitHub as a runner for the **Max benchmark** workflow:

1. **GitHub runner token** (valid one hour): repository **Settings → Actions → Runners → New self-hosted runner → Linux**. Copy the token from the `./config.sh --url … --token XXXX` line.
2. **DigitalOcean API token**: **API → Tokens → Generate New Token**, expiry 1 day, **Custom scopes → droplet: delete** (it adds `read` itself). The Droplet uses it only to delete itself at the end. DigitalOcean takes Google Pay (in Chrome) and Apple Pay (in Safari) under **Billing → Payment methods**.
3. **Create the Droplet**: **Create → Droplets** → region **Amsterdam** or Frankfurt → **Ubuntu 24.04** → **Basic → Regular → 8 vCPU / 32 GB** → **Advanced options → Add initialized data (User data)** → paste [`benchmark/digitalocean-cloud-init.yaml`](benchmark/digitalocean-cloud-init.yaml) with the two tokens filled in → choose any SSH key or password (you won't need it) → **Create Droplet**.
4. Start **Actions → Max benchmark → Run workflow** (if it isn't already queued). The job waits until the runner appears.

The Droplet installs the build tools, builds the pinned llama.cpp, downloads Max (checked against its SHA-256) and HumanEval, runs all 164 problems and uploads `humaneval-max.json` as a workflow artifact with a summary. Then the runner exits and the Droplet deletes itself. The job stops after 11½ hours and the Droplet after 12 at the latest. The Basic 8 vCPU / 32 GB Droplet is $192 a month, billed by the second (about $0.29 an hour, roughly 2.3 kr with Danish VAT), so even the 12-hour worst case stays under 30 kr. Check **Droplets** afterwards to be sure it's gone, then delete the API token.

**Paying by card instead:** Hetzner's **CCX33** (8 dedicated vCPUs, 32 GB) is cheaper, at €0.1891 an hour excl. VAT (about 1.76 kr with Danish VAT, so about 21 kr for the full 12 hours). Use [`benchmark/hetzner-cloud-init.yaml`](benchmark/hetzner-cloud-init.yaml) in the **Cloud config** box, and a Hetzner API token (project → **Security → API tokens**, **Read & Write**) in place of the DigitalOcean one. Hetzner takes cards and PayPal, but not Google Pay or Apple Pay.

**Akamai Cloud (Linode), by card:** the **Shared CPU → Linode 32 GB** plan (8 CPUs) is $0.288 an hour, about 30 kr with Danish VAT for the full 12 hours, and new accounts have been offered free trial credit. Create a personal access token (profile → **API Tokens → Create**, **Linodes: Read/Write**, expiry 1 day), then create the Linode with **Ubuntu 24.04** in a region whose form offers **Add User Data** (for example Amsterdam or Stockholm), and paste [`benchmark/linode-cloud-init.yaml`](benchmark/linode-cloud-init.yaml) there.

The runner only takes one job and the repository is public, so start the workflow before or right after creating the server; the queued benchmark job is what it picks up.
