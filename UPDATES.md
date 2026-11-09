# App updates

New platform-specific desktop packages check for signed app updates when the welcome screen opens. Click **Update and restart** to install. You do not need to download or extract another complete ZIP for ordinary app updates. Checks can be disabled on the welcome screen. Offline checks fail quietly and do not prevent Start.

Older copies cannot gain an updater remotely: download a complete package once after this change is released. Keep the entire extracted folder together, in a location you can write to. The universal development stick and terminal/browser fallbacks do not install desktop updates; use a platform-specific desktop package.

## Private GitHub access

This repository is now public: normal update checks and downloads need no GitHub token. For a private deployment, on the welcome screen open **Private GitHub access** and save a fine-grained GitHub token with **Contents: Read-only** access to `alfredmurray-goat/stick_ai`, and check again. Organization approval or repository access may also be required by GitHub. Expired or revoked tokens can be replaced there. **Remove saved access** deletes the saved token. Public release feeds do not require a token.

The token is saved in `updates.json` in Tauri's per-user application configuration directory, outside the stick and its project. It is stored as plaintext with the user's normal filesystem protection (mode 0600 on Unix), not in an OS credential vault. It never goes into model requests, project context, command-line arguments or logs. Updater processes receive it through stdin. The token is sent only to `api.github.com`, and is stripped from redirects to GitHub's download CDN. An optional `STICK_UPDATE_TOKEN` environment variable overrides saved access for managed deployments.

Only the updater contacts GitHub for release metadata and app downloads. Questions and project contents remain local. Turning off automatic checks avoids the startup network request; the manual Check button still works. The assistant itself has no cloud fallback or telemetry.

## What changes during installation

Each platform gets a compressed app payload containing the desktop executable, UI, launcher, verification/update helpers, runtime binaries, launch scripts and redistribution notices. **No GGUF model bytes are included.** App payloads can still be tens or hundreds of megabytes because they contain the native app and runtimes. These are app-only updates, not binary deltas.

The updater verifies an Ed25519 signature against the public key built into the app, the signed package size/SHA256, platform and release identity, every extracted file hash, and safe file paths. It refuses older releases, changed model requirements, symlinks and unexpected files. A model-changing release requires a complete package; models are never silently replaced or redownloaded.

The new app is staged beside the current folder. After the desktop app exits, a temporary helper moves the old app aside, moves the existing models, `app/project` and logs into the staged version, verifies the result, and restores the original folder name. Models are moved on the same filesystem: they are neither copied nor downloaded. The app then reopens. This also avoids replacing an executable while Windows is using it. Installing is available before starting the assistant, so it cannot interrupt an active model task.

The old app files remain in a sibling `.FOLDER.update-XXXXXX/previous` folder; they no longer contain your models or project. `rollback.json` records its original location. An installation error attempts to reverse all data moves and restore the previous app. Staging, old app files and a diagnostic log may remain after failure. Do not unplug the drive during installation. Power loss, forced termination, disk errors or other processes holding files open can prevent complete recovery; the previous folder and the staging `next` folder should be inspected before deleting anything. Updates require free space for the downloaded payload, staging and temporary app/runtime copies, but not a second copy of the models. A temporary copy of Node is cleaned up after the app reopens.

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
