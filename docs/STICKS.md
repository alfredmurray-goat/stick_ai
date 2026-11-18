# Making a Stick AI stick

Every build that passes on `main` publishes one **private draft** release, **Stick AI — all devices — build N**, on [GitHub Releases](https://github.com/alfredmurray-goat/stick_ai/releases). Only people with write access can see it. Its notes repeat these steps.

## What you need

- A USB stick of **32 GB or more**. USB 3 makes the models load much faster.
- The stick formatted as **exFAT**. FAT32 can't hold files over 4 GB, and Max is 14 GB. exFAT works on Mac, Windows and Linux.
  - Mac: Disk Utility → select the stick → Erase → Format **ExFAT**, Scheme **GUID Partition Map**.
  - Windows: right-click the stick in File Explorer → Format → File system **exFAT**.
- About 40 GB of free space on your computer while you prepare the first stick.

## Steps

1. Open the newest **Stick AI — all devices** draft and download every `stick_ai-all-devices.tar.partNN` file into one folder, plus the Join helper for your computer:
   - Mac: `Join-stick_ai-all-devices.command.zip`. Unzip it and double-click the `.command` file (right-click → Open the first time).
   - Windows: `Join-stick_ai-all-devices.bat`. Double-click it.
   - Linux: `Join-stick_ai-all-devices.sh.zip`. Unzip it and run `sh Join-stick_ai-all-devices.sh`.

   The helper checks every part against its SHA-256 and builds `stick_ai-all-devices.tar` (about 19 GB). Keep this file: you can extract it onto as many sticks as you like.
2. Extract it onto the stick. This creates a `Stick AI` folder on the stick:
   - Mac: `tar -xf stick_ai-all-devices.tar -C "/Volumes/STICK AI"`
   - Windows (Command Prompt): `tar -xf stick_ai-all-devices.tar -C E:\` (your stick's drive letter)
   - Linux: `tar -xf stick_ai-all-devices.tar -C "/media/$USER/STICK AI"`
3. Test it: open `Stick AI`, then `Stick AI.app` (Mac), `Stick AI.exe` (Windows) or `stick-ai` (Linux), and click **Open workspace**.
4. Eject the stick properly before unplugging it.

## What's on the stick

| Path | What it is |
| --- | --- |
| `Stick AI.app` | The Mac app, one universal app for Apple Silicon and Intel |
| `Stick AI.exe` | The Windows app |
| `stick-ai` | The Linux app |
| `bin/<computer>/` | Node.js and the llama.cpp server for each computer |
| `app/` | The assistant, shared by every computer |
| `models/` | Stellan-1 Lite and Max, stored once |
| `Start.command`, `Start.bat`, `start.sh` | Fallbacks that open the workspace in a browser |
| `manifest.json` | SHA-256 of every file. The app refuses to start if a file was changed |

The stick checks for app updates at `updates.localilabs.com` (see [UPDATES.md](UPDATES.md)). All-devices sticks download the `universal` update, so an update never removes another computer's app.

## How the release is built

1. Each platform job in **Desktop builds** packages and tests its own app, including a real Lite tool exchange.
2. The `macos-universal` job merges the Intel and Apple Silicon Mac apps into one universal binary with `lipo`, ad-hoc signs it again and checks that it starts.
3. **Publish stick release** (`scripts/publish-stick.mjs`) merges the four packages with `assembleUniversalStick` (`src/portable/universal.ts`), adds Max once, verifies every file, builds the all-devices update, and uploads the image in 2 GB parts with Join helpers and checksums. Nothing becomes public unless `STICK_PUBLIC_RELEASES=1`.
