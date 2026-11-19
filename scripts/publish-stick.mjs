// Publishes ONE private draft release per build: a small zip with the all-devices stick files (Mac, Windows
// and Linux apps plus the shared stellan folder, without models) and install helpers, checksums and the
// signed app updates. Sticks already carry the models in stellan/models; the apps use them from there.
// Releases stay drafts, visible only to people with write access, unless STICK_PUBLIC_RELEASES=1.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { successfulDesktopBuild } from "./release-build.mjs";
import { publishAppUpdate } from "./publish-app-update.mjs";
import { writeInstallers } from "./stick-installers.mjs";
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

**One download for every stick:** the apps for Mac (Apple Silicon and Intel), Windows and Linux, and the shared \`stellan\` folder. **No model files**: the apps use the ones already on the stick in \`stellan/models\`. Private draft: only people with write access to this repository can see it.

## Put it on a stick

1. The stick: **exFAT**, 32 GB or more, with the models in \`stellan/models\` named exactly \`stellan-1-lite-q4_k_m.gguf\` and \`stellan-1.0-q4_k_m.gguf\`.
2. Download **\`stick_ai-all-devices.zip\`** and unzip it.
3. Open the helper for your computer and follow it:
   - Mac: **Install on stick (Mac).command** (right-click → Open the first time), then drag the stick into its window.
   - Windows: **Install on stick (Windows).bat**, then type the stick's drive letter.
   - Linux: \`sh install-on-stick.sh /media/$USER/STICK_AI\`
4. The helper copies the apps and the \`stellan\` folder onto the stick **without deleting anything**, so your models stay put, and tells you if a model is missing. Don't drag \`stellan\` onto the stick in Finder: "Replace" would delete the models.
5. Open the app for the computer (\`Stick AI.app\`, \`Stick AI.exe\` or \`stick-ai\`) and click **Open workspace**. The first start checks the models in full once; later starts skip that.

## Files

| File | What it is |
| --- | --- |
| \`stick_ai-all-devices.zip\` | The apps, the \`stellan\` folder (without models) and the install helpers |
| \`RELEASE_CHECKSUMS.json\` | SHA-256 of the zip |
| \`stick_ai-update-*.gz\`, \`stick_ai-updates.json\` | Signed app updates, also sent to sold sticks through the update host |

Source: ${run.head_sha}. Built ${date}. [Build checks](https://github.com/${repo}/actions/runs/${runId}).
`;
try {
  const notesFile = join(temporary, "notes.md"); await writeFile(notesFile, notes);
  let existing;
  try { existing = JSON.parse(await gh("release", "view", tag, "--repo", repo, "--json", "isDraft")); } catch (error) { if (!/release not found|HTTP 404/i.test(String(error.stderr))) { throw error; } }
  if (!existing) { await gh("release", "create", tag, "--repo", repo, "--target", run.head_sha, "--title", `Stick AI — all devices — build ${runId} (${date})`, "--draft", "--prerelease", "--notes-file", notesFile); }

  // Extract the four verified platform packages. Their Lite copies are dropped: the stick brings its own models.
  const bases = {};
  for (const platform of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
    const folder = join(temporary, "bases", platform); await mkdir(folder, { recursive: true });
    await gh("run", "download", runId, "--repo", repo, "--name", `stick_ai-base-${platform}`, "--dir", folder);
    const [archive] = await readdir(folder);
    if (archive.endsWith(".tar.gz")) { await exec("tar", ["-xzf", join(folder, archive), "-C", folder]); } else { await exec("unzip", ["-q", join(folder, archive), "-d", folder]); }
    await rm(join(folder, archive));
    bases[platform] = join(folder, "Stick AI");
    await rm(join(bases[platform], "models/stellan-1-lite-q4_k_m.gguf"), { force: true });
  }
  const macFolder = join(temporary, "macapp"); await mkdir(macFolder);
  await gh("run", "download", runId, "--repo", repo, "--name", "stick_ai-macapp-universal", "--dir", macFolder);
  await exec("tar", ["-xf", join(macFolder, "stick_ai-macapp-universal.tar"), "-C", macFolder]);
  // stick_ai/ is the stick's top level: the three apps, "Read me.txt" and the shared stellan folder.
  const download = join(temporary, "download"); await mkdir(download);
  const stick = join(download, "stick_ai");
  await assembleUniversalStick(stick, { bases, macApp: join(macFolder, "Stick AI.app"), models: false }, console.log);
  await rm(join(temporary, "bases"), { recursive: true, force: true }); await rm(macFolder, { recursive: true, force: true });
  console.log("Assembled and verified the all-devices stick");

  // Updates: the four platform bundles from the build plus one for all-devices sticks, in this release and on the update host.
  const universal = join(temporary, "stick_ai-update-universal.gz");
  await buildUpdateBundle(join(stick, "stellan"), "universal", universal, true, await universalUpdateSource(stick));
  await publishAppUpdate({ repo, runId, source: run.head_sha, artifacts, platforms, temporary, signingKey: process.env.STICK_UPDATE_SIGNING_KEY, gh, tag, ownRelease: false, universal });
  await rm(universal);

  await writeInstallers(download);
  const zip = join(temporary, "stick_ai-all-devices.zip");
  // -y keeps the Mac app's internal links; Info-ZIP also keeps the "can run" permissions.
  await exec("zip", ["-q", "-r", "-y", zip, "stick_ai", "Install on stick (Mac).command", "Install on stick (Windows).bat", "install-on-stick.sh", "How to install.txt"], { cwd: download, maxBuffer: 1000000 });
  await rm(download, { recursive: true, force: true });
  const hash = createHash("sha256"); for await (const chunk of createReadStream(zip)) { hash.update(chunk); }
  const record = { name: "stick_ai-all-devices.zip", size: (await stat(zip)).size, sha256: hash.digest("hex") };
  console.log(`stick_ai-all-devices.zip: ${(record.size / 1024 ** 2).toFixed(0)} MB`);
  await gh("release", "upload", tag, zip, "--repo", repo, "--clobber");
  const checksums = join(temporary, "RELEASE_CHECKSUMS.json");
  await writeFile(checksums, JSON.stringify({ source: run.head_sha, run: runId, archives: [record] }, null, 2) + "\n");
  await gh("release", "upload", tag, checksums, "--repo", repo, "--clobber");
  const publicRelease = process.env.STICK_PUBLIC_RELEASES === "1";
  await gh("release", "edit", tag, "--repo", repo, "--notes-file", notesFile, ...(publicRelease ? ["--draft=false"] : []));
  console.log(publicRelease ? `Published https://github.com/${repo}/releases/tag/${tag}` : `Private draft ready (only people with write access can see it): https://github.com/${repo}/releases`);
} finally { await rm(temporary, { recursive: true, force: true }); }
