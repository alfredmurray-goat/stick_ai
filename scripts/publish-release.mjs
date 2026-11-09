import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitArchive, joinHelper } from "./release-parts.mjs";
const exec = promisify(execFile);
const repo = process.env.GITHUB_REPOSITORY; const runId = process.env.BUILD_RUN;
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo ?? "") || !/^\d+$/.test(runId ?? "")) { throw new Error("Missing release repository or run ID"); }
async function gh(...args) { const result = await exec("gh", args, { maxBuffer: 4000000 }); return result.stdout; }
const run = JSON.parse(await gh("api", `repos/${repo}/actions/runs/${runId}`));
if (run.conclusion !== "success" || run.head_branch !== "main" || run.path !== ".github/workflows/desktop.yml" || run.head_repository.full_name !== repo || !["push", "workflow_dispatch"].includes(run.event)) { throw new Error("Only successful trusted main desktop builds can be released"); }
const artifacts = JSON.parse(await gh("api", `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts;
const platforms = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"];
const selected = platforms.map((platform) => { const artifact = artifacts.find((item) => item.name === `stick_ai-${platform}` && !item.expired); if (!artifact) { throw new Error(`Missing complete ${platform} build`); } return { platform, artifact }; });
const tag = `lite-${runId}`; const temporary = await mkdtemp(join(tmpdir(), "stick-release-"));
try {
  const notes = join(temporary, "notes.md");
  const body = `# Stellan-1 Lite desktop builds\n\nComplete updated builds for Apple Silicon Mac, Intel Mac, Windows x64 and Linux x64, including Lite and local runtimes.\n\n## Complete downloads\n\nThese single-download packages are retained until ${selected[0].artifact.expires_at.slice(0, 10)}; after downloading, extract the outer ZIP and the archive inside it, keep the folder together, then open Stick AI and click Start.\n\n${selected.map(({platform, artifact}) => `- [${platform}: complete package](https://github.com/${repo}/actions/runs/${runId}/artifacts/${artifact.id})`).join("\n")}\n\n## Permanent release assets\n\nGitHub limits each release asset to less than 2 GiB, so complete permanent packages are split into parts. Download every part and the Join helper for your platform into the same folder. If the helper is a ZIP, extract it into that folder. Open the Join helper once, then extract the finished archive. The helpers verify part and archive hashes and need no typed commands; they show a terminal during this one-time preparation. If macOS blocks the helper, right-click it and choose Open once. Technical users can also reassemble the parts in listed order using RELEASE_CHECKSUMS.json. Keep the original parts until the finished app has been checked.\n\n## Requirements and limits\n\n- At least 8 GiB reported memory; Lite only, with the existing Max lock and optional specialist support in source. Max weights are not included.\n- Macs: macOS 13.5+. Windows: Windows 10+ with existing Edge WebView2. Linux: glibc 2.35+, GTK 3 and WebKitGTK 4.1 already available. x64 inference targets AVX2-capable CPUs.\n- Unsigned test builds: Gatekeeper, SmartScreen, clean-machine GUI launch, physical USB performance and memory behavior still require manual qualification.\n- Real Lite streaming and read_file/tool_result/done checks passed on all four build runners. This does not guarantee coding accuracy; review proposed changes.\n- The app stays on authenticated loopback, checks package hashes, retains cancellation and inactivity progress, and uses Lite's low-memory Mamba2 settings.\n- Authored code remains MIT. Each package includes model and third-party notices; see MODEL_LICENSE.md for outstanding Lite provenance and training-template qualification.\n\nBuild source: ${run.head_sha}. [Build checks](https://github.com/${repo}/actions/runs/${runId}).\n`;
  await writeFile(notes, body);
  let existing;
  try { existing = JSON.parse(await gh("release", "view", tag, "--repo", repo, "--json", "isDraft")); } catch (error) { if (!/release not found|HTTP 404/i.test(String(error.stderr))) { throw error; } }
  if (existing && !existing.isDraft) { console.log(`Release already published: https://github.com/${repo}/releases/tag/${tag}`); process.exitCode = 0; }
  else {
    if (!existing) { await gh("release", "create", tag, "--repo", repo, "--target", run.head_sha, "--title", "Stellan-1 Lite — all desktop builds", "--draft", "--prerelease", "--notes-file", notes); }
    const records = [];
    for (const { platform, artifact } of selected) {
      const folder = join(temporary, platform);
      console.log(`Preparing permanent release assets for ${platform}`);
      await gh("run", "download", runId, "--repo", repo, "--name", artifact.name, "--dir", folder);
      const files = await readdir(folder); if (files.length !== 1) { throw new Error("Unexpected package artifact contents"); }
      const input = join(folder, files[0]); const partsFolder = join(folder, "parts");
      const record = await splitArchive(input, partsFolder); records.push(record);
      const helper = await joinHelper(record, partsFolder, platform);
      let helperAsset = helper;
      if (platform !== "windows-x64") {
        helperAsset = helper + ".zip";
        await exec("zip", ["-j", join(partsFolder, helperAsset), join(partsFolder, helper)]);
      }
      for (const file of [...record.parts.map((part) => part.name), helperAsset]) { await gh("release", "upload", tag, join(partsFolder, file), "--repo", repo, "--clobber"); }
      await rm(folder, { recursive: true, force: true });
    }
    const checksums = join(temporary, "RELEASE_CHECKSUMS.json"); await writeFile(checksums, JSON.stringify({ source: run.head_sha, run: runId, archives: records }, null, 2) + "\n");
    await gh("release", "upload", tag, checksums, "--repo", repo, "--clobber");
    await gh("release", "edit", tag, "--repo", repo, "--notes-file", notes, "--draft=false");
    console.log(`Published https://github.com/${repo}/releases/tag/${tag}`);
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
