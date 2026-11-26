# App updates

New platform-specific desktop packages check for signed app updates when the welcome screen opens. Click **Update and restart** to install. You do not need to download or extract another complete ZIP for ordinary app updates. Checks can be disabled on the welcome screen. Offline checks fail quietly and do not prevent Start.

Older copies cannot gain an updater remotely: download a complete package once after this change is released. Keep the entire extracted folder together, in a location you can write to. The universal development stick and terminal/browser fallbacks do not install desktop updates; use a platform-specific desktop package.

## Where updates come from

Stick AI is sold preinstalled on sticks and its GitHub releases are private drafts, so sold copies don't update from GitHub. Builds made after this change check a private update host instead: `https://updates.localilabs.com/stick-ai/stick_ai-updates.json` (set at build time with `STICK_UPDATE_FEED`, stored as `feed` in `app/update-config.json`). It's a Cloudflare R2 bucket on a custom domain. No token is needed, and the host doesn't have to be trusted: the feed is Ed25519-signed and every bundle is checked by size and SHA-256 before anything is installed. Downloads may only redirect within the same host.

Each build is uploaded to its own folder (`stick-ai/RUN_ID/stick_ai-update-PLATFORM.gz`), and the feed is uploaded last with `no-cache`, so sticks never see a feed whose files aren't there yet. The publisher never moves the feed back to an older build. A missing feed simply means "up to date".

### Setting up the update host (once)

1. In Cloudflare, open **R2 Object Storage** and create a bucket called `stick-ai-updates`.
2. In the bucket's **Settings → Custom Domains**, connect `updates.localilabs.com`. The domain must be on Cloudflare DNS in the same account.
3. Under **R2 → Manage API tokens → Create API token**, give it **Object Read & Write**, limited to `stick-ai-updates`. Copy the **token value** (the long one at the top, not the Access Key ID or Secret).
4. In GitHub, under **Settings → Secrets and variables → Actions**:
   - **Secrets** tab: add `CLOUDFLARE_API_TOKEN` with that token value.
   - **Variables** tab: add `R2_ACCOUNT_ID` with your 32-character Cloudflare account ID (shown on the R2 overview page). It isn't secret.

The publisher turns the token into R2 upload keys as Cloudflare documents (the access key ID is the token's ID; the secret is the SHA-256 of the token). The older four-secret setup (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) still works. A bucket with another name needs an `R2_BUCKET` variable.

To check it without waiting for a new build, run **Publish stick release** (`release.yml`) by hand with the run ID of a Desktop build from the last day: the log should end with "Sold sticks will now update to build …", and the feed URL above should then download.

Every successful build on `main` then goes out to sold sticks automatically. Without these secrets, publishing still works but skips the host, and the log says so.

### Older GitHub-based copies

Copies built before the update host have no `feed` and still look at GitHub releases, which are now private drafts, so they find nothing. They can be moved over by installing a current build once. The **Private GitHub access** box only appears for these copies when GitHub asks for access.

The saved token, if any, lives in `updates.json` in Tauri's per-user application configuration directory (mode 0600 on Unix), is sent only to `api.github.com`, and never goes into model requests, project context, command-line arguments or logs. An optional `STICK_UPDATE_TOKEN` environment variable overrides it for managed deployments.

Only the updater contacts the update host. Questions and project contents remain local. Turning off automatic checks avoids the startup network request; the manual Check button still works. The assistant itself has no cloud fallback or telemetry.

## What changes during installation

Each platform gets a compressed app payload containing the desktop executable, UI, launcher, verification/update helpers, runtime binaries, launch scripts and redistribution notices. **No GGUF model bytes are included.** App payloads can still be tens or hundreds of megabytes because they contain the native app and runtimes. These are app-only updates, not binary deltas.

The updater verifies an Ed25519 signature against the public key built into the app, the signed package size/SHA256, platform and release identity, every extracted file hash, and safe file paths. It refuses older releases, changed model requirements, symlinks and unexpected files. A model-changing release requires a complete package; models are never silently replaced or redownloaded.

The new app is staged beside the current folder. After the desktop app exits, a temporary helper moves the old app aside, moves the existing models, `app/project` and logs into the staged version, verifies the result, and restores the original folder name. Models are moved on the same filesystem: they are neither copied nor downloaded. The app then reopens. This also avoids replacing an executable while Windows is using it. Installing is available before starting the assistant, so it cannot interrupt an active model task.

The old app files remain in a sibling `.FOLDER.update-XXXXXX/previous` folder; they no longer contain your models or project. `rollback.json` records its original location. An installation error attempts to reverse all data moves and restore the previous app. Staging, old app files and a diagnostic log may remain after failure. Do not unplug the drive during installation. Power loss, forced termination, disk errors or other processes holding files open can prevent complete recovery; the previous folder and the staging `next` folder should be inspected before deleting anything. Updates require free space for the downloaded payload, staging and temporary app/runtime copies, but not a second copy of the models. A temporary copy of the updater is cleaned up after the app reopens.

**Who runs the update.** When the stick's Stellan-Host and `app/trusted-roots.pem` match the manifest, the desktop app
runs Host's own updater (`stellan-host --update`, `experimental/stellan-runtime/src/updater.cpp`): the same checks,
signature, download, staging, swap and rollback as `src/portable/update.ts`, with no Node. Older sticks, or
`STICK_UPDATES_ON_NODE=1`, use the Node updater (`app/stick-update.cjs`) as before.

## Publishing signed updates

1. Add the private Ed25519 PEM key corresponding to `src/portable/update-key.ts` as the GitHub Actions repository secret **STICK_UPDATE_SIGNING_KEY**. Never commit the private key. Keep a secure backup; existing installed copies trust the matching public key.
2. Merge and let **Desktop Lite builds** complete on all four platforms. Each build uploads its complete package and a separate `stick_ai-update-PLATFORM.gz` artifact, with the GitHub run ID and source commit in `app/update-config.json`.
3. **Publish desktop release** first publishes the four app payloads and signed `stick_ai-updates.json` in a small `app-RUN_ID` release. The file-picker update is then available immediately through Check for updates. It subsequently downloads the pinned Max file once and assembles/publishes the complete two-model packages in a separate `desktop-RUN_ID` release. Release publication happens only after every asset is present. The updater considers prereleases as well as normal releases, because current desktop test builds are prereleases.

Without the signing secret, complete packages continue to publish, but no app update feed is published. A mismatched signing key fails publication rather than signing an update that installed apps cannot verify. Release signing is separate from Apple Developer ID and Windows Authenticode signing; these remain unsigned test builds at the operating-system level.

The publisher validates that its build came from a successful trusted main-branch desktop workflow. GitHub release metadata and redirect destinations are restricted to GitHub API/download hosts; app payloads are authenticated independently by the pinned signing key. No GitHub write credential is distributed with the app. Requests are checked against the installed run ID and source commit to prevent normal update downgrades. Compromising the signing key or the trusted source/build pipeline is outside that protection.

## Validation

Run `npm run check`, `npm test` and `npm run build`. Update tests cover signature tampering, replay/downgrade, path/platform validation, CDN credential stripping, offline/private checks, model-changing updates, corrupted staging, project/log/model preservation and rollback after partial data transfer. Model inode preservation verifies that models are moved rather than duplicated. Native commands are compiled by the CI matrix on macOS, Windows and Linux. Clean-machine GUI restart, physical USB removal and OS permission behavior still need platform qualification.

## Lite-only to unified app

New complete releases include both Lite and Max. Existing Lite-only installations can receive the unified app/UI through the app-only updater: the new Max record is optional, so no weight download is forced. Link an existing compatible Max GGUF on the welcome screen, or obtain the complete Lite + Max package if you need both weight files. Full releases use the same pinned Max record as the app update. An external Max selection lives in the preserved logs directory and survives app updates. App updates never silently replace external weights.
