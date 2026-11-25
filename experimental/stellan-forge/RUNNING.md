# Running Forge for free: the full guide

This takes about two hours the first time. Every step is free (prices and limits checked 25 November 2026; free tiers
change, so read each sign-up page). You need: an email address, a phone number, and a bank card for Oracle's
identity check (it is not charged while you stay on "Always Free").

The shape of it:

```
Oracle VM (free, always on)                    You (laptop or phone)
  Ollama + Stellan Lite/Max                      read every diff
  stick CLI: writes the fix, runs tests   --->   approve or reject
  pr.py: opens the PR after you type OPEN        answer maintainers
```

---

## Part 1. The bot's GitHub account (15 minutes)

1. Sign out of GitHub (or use a private browser window) and sign up at github.com with a **new email address**.
   Use a username that says what it is, for example `stellan-forge-bot`.
2. **Settings → Password and authentication → Enable two-factor authentication.** Use an authenticator app and save
   the recovery codes somewhere safe (a password manager).
3. **Settings → Public profile.** Set the name to "Stellan Forge (AI-assisted)" and the bio to:
   `AI-assisted open-source fixes by Stellan, an EU coding model. Every PR is reviewed by <your name> before it is
   opened. Contact: <your public email or your main GitHub username>.`
   GitHub allows one free machine account per person; you are responsible for what it does.
4. **Make the key the scripts use.** Settings → Developer settings → Personal access tokens → **Fine-grained tokens** →
   Generate new token:
   - Name: `forge`. Expiration: 90 days (renew it when GitHub emails you).
   - Repository access: **All repositories** (it needs its own forks, which don't exist yet). The bot owns nothing
     else, so this only reaches its forks.
   - Permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read** (automatic).
     Nothing else.
   - Copy the token **once**, straight into your password manager. Never paste it into a chat, a notebook cell,
     a file in a repository, or a screenshot.

## Part 2. The free server: Oracle Cloud "Always Free" (45 minutes)

Why Oracle: its free Arm server has 4 cores and 24 GB of memory with no time limit. That's enough for Lite (fast) and
Max (slow but usable). Kaggle and Codespaces stop after hours; Forge benefits from a machine that is always on.

1. Sign up at **oracle.com/cloud/free**. Pick a **home region** close to you (for example Frankfurt or Amsterdam).
   You can't change it later, and free Arm capacity varies by region.
2. When asked about the account type, stay on **Free Tier**. Never click "Upgrade to Pay As You Go".
3. In the console: **☰ → Compute → Instances → Create instance**.
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: **Ampere → VM.Standard.A1.Flex**, **4 OCPUs, 24 GB memory**. It must say "Always Free-eligible".
   - Networking: leave the defaults (a new public subnet).
   - SSH keys: choose **Generate a key pair for me** and **download both keys**. Keep the private key safe.
   - Boot volume: set **100 GB** (up to 200 GB is free).
   - Create. If you get "Out of capacity", try again later or pick another availability domain; this is common.
4. Copy the instance's **public IP address** from its page.
5. Connect from your computer (Mac/Linux terminal, or Windows PowerShell):

```bash
chmod 600 ~/Downloads/ssh-key-*.key
```

```bash
ssh -i ~/Downloads/ssh-key-YYYY-MM-DD.key ubuntu@YOUR.PUBLIC.IP
```

6. Basic safety, on the server:

```bash
sudo apt update && sudo apt -y upgrade && sudo apt -y install git curl python3 docker.io bubblewrap unattended-upgrades
```

```bash
sudo usermod -aG docker ubuntu && sudo dpkg-reconfigure -plow unattended-upgrades
```

Log out (`exit`) and back in so Docker works without `sudo`. Oracle's default firewall only allows SSH (port 22) in;
leave it that way. Nothing in Forge needs incoming connections.

## Part 3. Stellan on the server (30 minutes)

The stick app is built for Windows, Mac and Intel Linux. The Oracle server is Arm, so Forge uses the **terminal
version** (`stick`) with Ollama, which runs on Arm.

1. Install Node.js 24 and Ollama:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt -y install nodejs
```

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

2. Get the Stick AI code. The repository is private, so make a **read-only** fine-grained token on **your own**
   account for just `stick_ai` (Contents: Read), and clone with it:

```bash
git clone https://github.com/alfredmurray-goat/stick_ai.git && cd stick_ai
```

(Git asks for a username and password: give your username and paste the token as the password.)

```bash
npm install --ignore-scripts --no-audit --no-fund && npm run build && sudo npm link
```

3. Download the models into `ollama/` and check them. Lite's pinned link and SHA-256 are in
   `scripts/fetch-platform-assets.mjs` (Max's are in `scripts/assemble-full-release.mjs`). If you've made the
   Hugging Face repos private, first make a **read** token at huggingface.co → Settings → Access Tokens, and run
   `export HF_TOKEN=...` (type it, don't paste it anywhere else).

```bash
curl -L -H "Authorization: Bearer $HF_TOKEN" -o ollama/stellan-1-lite.gguf "PASTE_LITE_URL_FROM_THE_SCRIPT"
```

```bash
sha256sum ollama/stellan-1-lite.gguf
```

The printed hash must match the script's exactly. If it doesn't, delete the file and download it again. Do the same
for Max (`stellan-1-max.gguf`). Then:

```bash
cd ollama && ollama create stellan-1-lite -f Modelfile && ollama create stellan-1-max -f Modelfile.max && cd ..
```

4. Check it works:

```bash
stick doctor
```

It should show 24 GB of memory, Max unlocked, and the bubblewrap sandbox.

## Part 4. Forge's working folders and keys (10 minutes)

```bash
mkdir -p ~/forge/work ~/forge/records && chmod 700 ~/forge
```

Store the bot token so only you can read it, and load it only when opening a PR:

```bash
read -rs FORGE_GITHUB_TOKEN && printf '%s' "$FORGE_GITHUB_TOKEN" > ~/forge/.token && chmod 600 ~/forge/.token && unset FORGE_GITHUB_TOKEN
```

(`read -rs` lets you paste the token without it appearing on screen or in your shell history.)

Set Git's identity for the bot's commits:

```bash
git config --global user.name "Stellan Forge" && git config --global user.email "BOT_ID+stellan-forge-bot@users.noreply.github.com"
```

(Find `BOT_ID` at github.com/settings/emails while signed in as the bot.)

Create your allowlist, `~/forge/allowlist.json`. Add a project **only after reading its AI policy today**:

```json
[
  {"repo": "go-gitea/gitea", "policy_url": "https://github.com/go-gitea/gitea/blob/main/CONTRIBUTING.md", "policy_checked": "2026-11-25"}
]
```

(Check that link really is the policy; if a project keeps it somewhere else, use that link.)

## Part 5. One Forge round, step by step (about an hour per fix)

**1. Pick an issue.** On the project's GitHub, filter issues by `good first issue` or `help wanted`. Choose one that
is small, clearly described, not assigned, has no open PR, and has no "please don't use AI" comment. Comment on the
issue first, as the bot, if the project asks contributors to claim issues.

**2. Fork and clone it as the bot.** On github.com, signed in as the bot, press **Fork**. Then on the server:

```bash
cd ~/forge/work && git clone https://github.com/stellan-forge-bot/gitea.git && cd gitea
```

```bash
git remote add upstream https://github.com/go-gitea/gitea.git && git checkout -b fix-1234
```

**3. Let Stellan fix it.** In the project folder:

```bash
STICK_MODEL=stellan-1-lite stick run "Fix issue 1234 in go-gitea/gitea: <paste the issue text>. Find the cause, make the smallest change, add or update a test, and run the tests."
```

Approve or refuse each file change and command as it asks. For harder fixes use `STICK_MODEL=stellan-1-max`. Add `.stick/` to the clone's `.git/info/exclude` so its
history is never committed.

**4. Run the project's own tests yourself.** Read CONTRIBUTING.md for the right command (for example `make test` or
`go test ./...`). If they fail, keep working with `stick chat`, or stop and pick another issue.

**5. Review it properly.** Run `git diff upstream/main`. Read every line. Ask yourself: would I submit this under my own
name? Do I understand why it fixes the issue? Is it the smallest change? Does it follow the project's style? If not,
fix it or throw it away. Throwing work away is normal.

**6. Commit with the disclosure trailer, then push:**

```bash
git commit -am "Fix <short description> (#1234)" -m "Assisted-by: Stellan Lite"
```

If the project uses DCO sign-off (for example Cilium), add `-s`. Then:

```bash
git push -u origin fix-1234
```

(Username: the bot's; password: the bot token from `~/forge/.token`.)

**7. Write the PR description** in `~/forge/pr.md`: what was wrong, what you changed, how you tested it, and
`Fixes #1234`. Fill in the project's PR template if it has one.

**8. Open the PR** (checks the allowlist, the one-open-PR rule, adds the disclosure, asks you to type `OPEN`):

```bash
cd ~/stick_ai && FORGE_GITHUB_TOKEN="$(cat ~/forge/.token)" python3 experimental/stellan-forge/pr.py --repo go-gitea/gitea --branch fix-1234 --base main --title "Fix <short description>" --body ~/forge/pr.md --model Lite --reviewer "Your Name" --allowlist ~/forge/allowlist.json
```

**9. Follow it up.** Answer review comments within a few days. If maintainers ask for changes, make them (Stellan can
help; you still review), commit and push to the same branch. If they say they don't want AI-assisted PRs, thank them,
close it, and **remove the project from your allowlist**.

**10. Record the outcome** for training (merged, changes requested, or closed) with `forge.py record` and
`forge.py review` as described in README.md. Keep these records in `~/forge/records`, never in a repository.

## Part 6. Pace and the 200 target

- One open PR per project; spread across 10–20 projects. A sensible pace is a few PRs a week to start with.
- Track your merge rate. If most PRs are closed, slow down and pick easier issues. Maintainers' goodwill is the
  scarce resource.
- 200 PRs at that pace is a few months. Fixes that pass the tests but that you decide not to send still make useful
  (approved) training records, so the dataset grows faster than the PR count.

## Using Kaggle instead (no always-on server)

Kaggle gives 30 GPU hours a week and 12-hour sessions, with internet after phone verification. Create a notebook,
switch on **Internet** and a **GPU**, add the bot token under **Add-ons → Secrets**, then run Parts 3–5 in notebook
cells (prefix shell commands with `!`). Everything on disk is deleted when the session ends, so push the branch before
it ends, and open the PR from your own computer with `pr.py` after reviewing it there.

## Stopping safely

- To pause Forge: stop opening PRs. Nothing runs by itself.
- To shut down the server: Oracle console → Instance → **Stop**. It stays free while stopped.
- If the bot's token might have leaked: GitHub (as the bot) → Settings → Developer settings → delete the token, then
  make a new one.
