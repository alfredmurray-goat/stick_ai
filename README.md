# Stick AI website

The landing page for stick_ai. Plain HTML and CSS in `public/`: no build step, no JavaScript in the page, no third-party requests (fonts are self-hosted under their OFL licences in `public/fonts/`). `api/interest.js` is a small Vercel function behind the "notify me" form.

## Deploy on Vercel

1. In Vercel, choose **Add New → Project** and import `alfredmurray-goat/stick_ai`.
2. **Framework Preset:** Other. **Root Directory:** `./`. **Output Directory:** `public` (also set in `vercel.json`). Leave the build and install commands empty.
3. Under **Settings → Environments → Production → Branch Tracking**, set the branch to `website`, then deploy the `website` branch from **Deployments → Create Deployment**.
4. Optional: **Settings → Git → Ignored Build Step** → custom: `[ "$VERCEL_GIT_COMMIT_REF" != "website" ]`, so app commits on `main` don't build previews.
5. Under **Settings → Domains**, add `stick-ai.localilabs.com` (a hyphen, not an underscore: hostnames with underscores can't get an HTTPS certificate). In Cloudflare DNS, add the CNAME record Vercel shows (name `stick-ai`), with the proxy **off** (DNS only).
6. For the sign-up form: **Storage → Create Database → Upstash for Redis**, connect it to this project, then redeploy. Sign-ups are stored in the hash `interest` (email → region, time, consent version). Without it, the form says sign-ups are briefly unavailable.

## Editing

- Prices: search `public/index.html` for `PRICE:`.
- Launch dates: search for `February 2027` and `May 2027`.
- Logos live in `public/img/brand/` (dark and light versions; the page swaps them with the system theme).

## Benchmark chart selection

Owner preference (22 November 2026): the website chart is a selected historical comparison. Do not add comparison models whose published score exceeds Stellan-1 Max’s current measured score (currently 132/164, 80.5%). Models between Lite and Max are allowed. Keep the selection criterion visible and never present it as a complete leaderboard or evidence that Stellan outperforms all models. Retain primary sources, historical release/version labels and accurate per-row metrics; do not relabel unspecified pass@k or best-of-N scores as pass@1. Scores obtained with different metrics or setups are not evidence of a controlled head-to-head win.
