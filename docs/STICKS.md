# Making a Stick AI stick

Every build that passes on `main` publishes one **private draft** release, **Stick AI — all devices — build N**, on [GitHub Releases](https://github.com/alfredmurray-goat/stick_ai/releases). Only people with write access can see it. Its notes repeat these steps.

## What you need

- A USB stick of **32 GB or more**, formatted as **exFAT** (Max is a 14 GB file, too big for FAT32). USB 3 loads the models much faster.
  - Mac: Disk Utility → select the stick → Erase → Format **ExFAT**, Scheme **GUID Partition Map**.
  - Windows: right-click the stick in File Explorer → Format → File system **exFAT**.
- The two models in **`stellan/models`** on the stick, named exactly `stellan-1-lite-q4_k_m.gguf` (Lite) and `stellan-1.0-q4_k_m.gguf` (Max). Releases don't include them: copy them once, and every later release reuses them. They must be the official files; the app checks them against their SHA-256 on the first start.

## Steps

1. Open the newest **Stick AI — all devices** draft and download **`stick_ai-all-devices.zip`** (a few hundred MB). Unzip it.
2. Open the helper for your computer:
   - Mac: **Install on stick (Mac).command** (right-click → Open the first time), then drag the stick from the Finder sidebar into its window and press Return.
   - Windows: **Install on stick (Windows).bat**, then type the stick's drive letter.
   - Linux: `sh install-on-stick.sh "/media/$USER/STICK_AI"`.

   It copies the apps and the `stellan` folder onto the stick by merging: files are added or replaced, nothing is deleted, so `stellan/models` stays as it is. It then tells you if a model is missing.
   Don't drag `stellan` onto the stick in Finder instead: Finder's **Replace** deletes the folder on the stick, models included.
3. Test it: open `Stick AI.app` (Mac), `Stick AI.exe` (Windows) or `stick-ai` (Linux) and click **Open workspace**. The first start checks both models in full (about a minute or two from a USB stick); later starts remember that and skip it.
4. Eject the stick properly before unplugging it.

## What's on the stick

```
STICK AI (the USB stick)
├── Stick AI.app     Mac: one universal app for Apple Silicon and Intel
├── Stick AI.exe     Windows
├── stick-ai         Linux
├── Read me.txt
└── stellan/         everything the apps share
    ├── models/      stellan-1-lite-q4_k_m.gguf and stellan-1.0-q4_k_m.gguf, stored once
    ├── bin/         Node.js and the llama.cpp server for each computer
    ├── app/         the assistant (and app/project, your saved work)
    ├── manifest.json  SHA-256 of every file in stellan; the app refuses to start if one changed
    └── Start.command, Start.bat, start.sh, README.txt, LICENSES/
```

Each app looks for a `stellan` folder beside it (a platform package keeps the same files next to its app instead). Keep `stellan` next to the apps.

The stick checks for app updates at `updates.localilabs.com` (see [UPDATES.md](UPDATES.md)). All-devices sticks download the `universal` update: it replaces the files in `stellan` and the three apps beside it (keeping the old ones until it has finished), so an update never removes another computer's app, your work or the models.

## How the release is built

1. Each platform job in **Desktop builds** packages and tests its own app, including a real Lite tool exchange.
2. The `macos-universal` job merges the Intel and Apple Silicon Mac apps into one universal binary with `lipo`, ad-hoc signs it again and checks that it starts.
3. **Publish stick release** (`scripts/publish-stick.mjs`) merges the four packages with `assembleUniversalStick` (`src/portable/universal.ts`, `models: false`), verifies every file, builds the all-devices update, and uploads `stick_ai-all-devices.zip` with the install helpers (`scripts/stick-installers.mjs`) and checksums. Nothing becomes public unless `STICK_PUBLIC_RELEASES=1`.
