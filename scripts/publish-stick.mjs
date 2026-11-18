// Publishes ONE private draft release per build: the all-devices stick image (Mac, Windows and Linux on one
// stick, sharing one copy of Lite and Max), its Join helpers, checksums and the signed app updates.
// Releases stay drafts, visible only to people with write access, unless STICK_PUBLIC_RELEASES=1.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { successfulDesktopBuild } from "./release-build.mjs";
import { publishAppUpdate } from "./publish-app-update.mjs";
import { fetchMaxForRelease } from "./assemble-full-release.mjs";
import { joinHelper } from "./release-parts.mjs";
import { uploadSplitArchive } from "./upload-release-parts.mjs";
import { assembleUniversalStick, universalUpdateSource } from "../dist/portable/universal.js";
import { buildUpdateBundle } from "../dist/portable/update-package.js";

const exec = promisify(execFile);
const repo = process.env.GITHUB_REPOSITORY; const runId = process.env.BUILD_RUN;
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo ?? "") || !/^\d+$/.test(runId ?? "")) { throw new Error("Missing release repository or run ID"); }
async function gh(...args) { const result = await exec("gh", args, { maxBuffer: 4000000 }); return result.stdout; }
const platforms = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"];
const run = await successfulDesktopBuild(repo, runId, gh);
const artifacts = JSON.parse(await gh("api", `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts;
const artifact = (name) => { const found = artifacts.find((item) => item.name === name && !item.expired); if (!found) { throw new Error(`Missing build artifact ${name}`); } return found; };
for (const name of [...platforms.map((platform) => `stick_ai-base-${platform}`), "stick_ai-macapp-universal"]) { artifact(name); }

const date = new Date().toISOString().slice(0, 10);
const tag = `stick-${runId}`; const temporary = await mkdtemp(join(tmpdir(), "stick-release-"));
const notes = `# Stick AI: all devices, build ${runId}

**One stick for Mac (Apple Silicon and Intel), Windows and Linux.** The three apps sit at the top of the stick; everything they share, including one copy of Stellan-1 Lite and Max, is in the \`Stellan\` folder. Private draft: only people with write access to this repository can see it.

## Make a stick

1. Use a USB stick of **32 GB or more**, formatted as **exFAT** (Max is a 14 GB file, too big for FAT32). Name it \`STICK AI\`.
2. Download **every** \`stick_ai-all-devices.tar.partNN\` file into one folder, plus the Join helper for the computer you're using:
   - Mac: \`Join-stick_ai-all-devices.command.zip\`, unzip it, then double-click \`Join-stick_ai-all-devices.command\` (right-click → Open the first time).
   - Windows: double-click \`Join-stick_ai-all-devices.bat\`.
   - Linux: \`Join-stick_ai-all-devices.sh.zip\`, unzip it, then run \`sh Join-stick_ai-all-devices.sh\`.
   The helper checks every part and creates \`stick_ai-all-devices.tar\` (about 19 GB).
3. Extract it onto the stick. The apps and the \`Stellan\` folder land at the top of the stick:
   - Mac: \`tar -xf stick_ai-all-devices.tar -C "/Volumes/STICK AI"\`
   - Windows (Command Prompt): \`tar -xf stick_ai-all-devices.tar -C E:\\\` (use your stick's letter)
   - Linux: \`tar -xf stick_ai-all-devices.tar -C /media/$USER/STICK\\ AI\`
4. Check the stick: open the app for the computer (\`Stick AI.app\`, \`Stick AI.exe\` or \`stick-ai\`) and click **Open workspace**.

## Files

| File | What it is |
| --- | --- |
| \`stick_ai-all-devices.tar.part01\` … | The stick image, split into 2 GB parts |
| \`Join-stick_ai-all-devices.*\` | Joins and checks the parts (Mac, Windows, Linux) |
| \`RELEASE_CHECKSUMS.json\` | SHA-256 of the image and every part |
| \`stick_ai-update-*.gz\`, \`stick_ai-updates.json\` | Signed app updates, also sent to sold sticks through the update host |

Source: ${run.head_sha}. Built ${date}. [Build checks](https://github.com/${repo}/actions/runs/${runId}).
`;
try {
  const notesFile = join(temporary, "notes.md"); await writeFile(notesFile, notes);
  let existing;
  try { existing = JSON.parse(await gh("release", "view", tag, "--repo", repo, "--json", "isDraft")); } catch (error) { if (!/release not found|HTTP 404/i.test(String(error.stderr))) { throw error; } }
  if (!existing) { await gh("release", "create", tag, "--repo", repo, "--target", run.head_sha, "--title", `Stick AI — all devices — build ${runId} (${date})`, "--draft", "--prerelease", "--notes-file", notesFile); }

  // Extract the four verified platform packages. Only the Linux copy of Lite is kept; the stick shares it.
  const bases = {};
  for (const platform of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
    const folder = join(temporary, "bases", platform); await mkdir(folder, { recursive: true });
    await gh("run", "download", runId, "--repo", repo, "--name", `stick_ai-base-${platform}`, "--dir", folder);
    const [archive] = await readdir(folder);
    if (archive.endsWith(".tar.gz")) { await exec("tar", ["-xzf", join(folder, archive), "-C", folder]); } else { await exec("unzip", ["-q", join(folder, archive), "-d", folder]); }
    await rm(join(folder, archive));
    bases[platform] = join(folder, "Stick AI");
    if (platform !== "linux-x64") { await rm(join(bases[platform], "models/stellan-1-lite-q4_k_m.gguf"), { force: true }); }
  }
  const macFolder = join(temporary, "macapp"); await mkdir(macFolder);
  await gh("run", "download", runId, "--repo", repo, "--name", "stick_ai-macapp-universal", "--dir", macFolder);
  await exec("tar", ["-xf", join(macFolder, "stick_ai-macapp-universal.tar"), "-C", macFolder]);
  const max = await fetchMaxForRelease(join(temporary, "shared-models"));
  // The image is the stick's top level: the three apps, "Read me.txt" and the shared Stellan folder.
  const stick = join(temporary, "stick");
  await assembleUniversalStick(stick, { bases, macApp: join(macFolder, "Stick AI.app"), max }, console.log);
  await rm(join(temporary, "bases"), { recursive: true, force: true }); await rm(macFolder, { recursive: true, force: true });
  console.log("Assembled and verified the all-devices stick");

  // Updates: the four platform bundles from the build plus one for all-devices sticks, in this release and on the update host.
  const universal = join(temporary, "stick_ai-update-universal.gz");
  await buildUpdateBundle(join(stick, "Stellan"), "universal", universal, true, await universalUpdateSource(stick));
  await publishAppUpdate({ repo, runId, source: run.head_sha, artifacts, platforms, temporary, signingKey: process.env.STICK_UPDATE_SIGNING_KEY, gh, tag, ownRelease: false, universal });
  await rm(universal);

  const image = join(temporary, "stick_ai-all-devices.tar");
  await exec("tar", ["-cf", image, "-C", stick, "Stick AI.app", "Stick AI.exe", "stick-ai", "Read me.txt", "Stellan"], { maxBuffer: 1000000 });
  await rm(stick, { recursive: true, force: true }); await rm(join(temporary, "shared-models"), { recursive: true, force: true });
  const parts = join(temporary, "parts");
  const record = await uploadSplitArchive(image, parts, async (paths) => { await gh("release", "upload", tag, ...paths, "--repo", repo, "--clobber"); });
  await rm(image, { force: true });
  for (const platform of ["macos-arm64", "linux-x64", "windows-x64"]) {
    const helper = await joinHelper(record, parts, platform);
    // Zip the shell helpers so their "can run" permission survives the download.
    const asset = platform === "windows-x64" ? helper : `${helper}.zip`;
    if (asset !== helper) { await exec("zip", ["-j", join(parts, asset), join(parts, helper)]); }
    await gh("release", "upload", tag, join(parts, asset), "--repo", repo, "--clobber");
  }
  const checksums = join(temporary, "RELEASE_CHECKSUMS.json");
  await writeFile(checksums, JSON.stringify({ source: run.head_sha, run: runId, archives: [record] }, null, 2) + "\n");
  await gh("release", "upload", tag, checksums, "--repo", repo, "--clobber");
  const publicRelease = process.env.STICK_PUBLIC_RELEASES === "1";
  await gh("release", "edit", tag, "--repo", repo, "--notes-file", notesFile, ...(publicRelease ? ["--draft=false"] : []));
  console.log(publicRelease ? `Published https://github.com/${repo}/releases/tag/${tag}` : `Private draft ready (only people with write access can see it): https://github.com/${repo}/releases`);
} finally { await rm(temporary, { recursive: true, force: true }); }
