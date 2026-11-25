# Running Forge for free

Forge needs three things: a computer to run Stellan on, the bot's GitHub account, and you to review each change.
Every option below costs nothing (checked 25 November 2026; free tiers change, so check before you start).

## Option A (recommended): Oracle Cloud "Always Free" Arm VM

- 4 Arm cores and 24 GB RAM, free for as long as you keep it. That's enough to run Max (24B Q4) slowly and Lite quickly.
- Sign-up asks for a card to check you're a real person. It isn't charged while you stay on "Always Free" shapes.
  Don't upgrade the account.
- It runs all the time, so Forge can work on a fix while you sleep and you review it in the morning.

Setup:

```bash
sudo apt update && sudo apt install -y git docker.io python3 build-essential cmake
git clone https://github.com/alfredmurray-goat/stick_ai && cd stick_ai
# build Stellan-Run (Arm build) and fetch the Lite/Max weights with the pinned hashes
node scripts/fetch-platform-assets.mjs linux-arm64
```

## Option B: Kaggle notebook

- Free, with 30 GPU hours a week (two T4s) and internet access once you verify your phone number.
- Sessions stop after 12 hours and nothing on disk is kept, so it suits batches: "try 10 issues, save the results".
- Put the bot's GitHub token in **Add-ons → Secrets**. Never type it into a notebook cell.
- Download the results (diffs and test logs) before the session ends, then review and open the PRs from your own
  computer.

## Option C: GitHub Codespaces

- 120 core-hours a month free on a personal account. It's fine for trying Forge, but too small for steady use.

## The bot account

1. Make one account, for example `stellan-forge-bot`. The bio should say "AI-assisted contributions by Stellan,
   reviewed by <your name>".
2. Give it a **fine-grained token** that can only touch its own forks (public repositories, contents and pull
   requests). Keep the token in the VM's or Kaggle's secret storage only.
3. Turn on two-factor sign-in.

## One Forge round

1. Pick a project from `REPOS.md` and read its AI policy today.
2. Forge finds a small issue (a "good first issue" with clear tests), forks the project and lets Stellan write a fix.
3. The tests run in Docker (`runner.py`).
4. **You read the diff.** Approve it with `forge.py review` only if you understand it and would defend it yourself.
5. Forge opens the PR from the bot: it discloses the AI assistance in the description and adds an
   `Assisted-by: Stellan Lite` (or Max) trailer to the commit.
6. Have at most one open PR per project. Answer maintainers' comments yourself, or with Stellan's help and your review.
7. Record the outcome (merged, changes requested or closed). Approved records become training data.

## Opening the PR (step 5)

Commit the fix on a branch of the bot's fork with an `Assisted-by: Stellan Lite` trailer, push it, write the PR
description in a file, then:

```bash
FORGE_GITHUB_TOKEN=... python3 experimental/stellan-forge/pr.py --repo go-gitea/gitea --branch fix-1234 \
  --title "Fix ..." --body pr.md --model Lite --reviewer "Your Name" --allowlist ~/forge/allowlist.json
```

`allowlist.json` is your own list: `[{"repo": "go-gitea/gitea", "policy_url": "https://...", "policy_checked":
"2026-11-25"}]`. The script refuses projects not on it, policies not checked in the last 7 days, and projects where
the bot already has an open PR. It shows the changed files, adds the AI disclosure, and opens the PR only after you
type `OPEN`. Set the token from your secret storage (Kaggle secrets or the VM's environment), never by pasting it into
a chat.

## Not built yet

The Stellan adapter (step 2: Forge asking Stellan for the fix automatically). Until it lands, write the fix with
Stellan in the app.
