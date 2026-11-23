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
- Logos live in `public/img/brand/` (dark and light versions; the homepage swaps them with its reading mode).

## Benchmark chart selection

Owner preference (22 November 2026): the website chart is a selected historical comparison. Do not add comparison models whose published score exceeds Stellan-1 Max’s current measured score (currently 132/164, 80.5%). Models between Lite and Max are allowed. Keep the selection criterion visible and never present it as a complete leaderboard or evidence that Stellan outperforms all models. Retain primary sources, historical release/version labels and accurate per-row metrics; do not relabel unspecified pass@k or best-of-N scores as pass@1. Scores obtained with different metrics or setups are not evidence of a controlled head-to-head win.

Non-tech mode uses a light product layout with plain language, real app screenshots and clear next steps. Technical mode is dark with additional implementation detail. The source has switched to Stellan-Run; release completion and performance claims require their own evidence. The native host remains a prototype.

The homepage switch now pairs non-tech mode with a light palette and technical mode with a dark palette, independent of OS appearance. Branding follows that mode. The ownership section covers Stellan-Run, the native inference-host prototype, the original MCP client and local context/notes. The runtime is selected for the next release; superiority and completed backend/SDK replacement are not claimed. Historical HumanEval scores explicitly identify the prior evaluator.

## Product presentation

The homepage leads with actual app screenshots copied without modification from main's README assets: `docs/hero.png`, `docs/welcome-light.png`, `docs/approval.png` and `docs/settings.png`. These are example project screens, not benchmark or performance evidence. They are served locally under `public/img/app/`, with full-size links and no third-party requests. Non-tech is a light product landing page; technical keeps the same product focus in dark mode with more engineering detail. Both retain the transparent benchmark selection, launch status, activation and connectivity disclosures. `product.css` styles only the homepage; support pages retain `style.css`.

Brand spelling is **localilabs**, lowercase. Technical mode keeps a monospace workbench layout and a static architecture summary alongside the real app screens. The original large ASCII `stick_ai` footer is visible in both modes. The architecture panel is labeled as configuration information, not live telemetry.
