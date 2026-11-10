import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, statfs, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { successfulDesktopBuild } from "./release-build.mjs";
import { fetchMaxForRelease } from "./assemble-full-release.mjs";
import { prepareDmgModels, createMacDiskImage } from "./macos-dmg.mjs";
import { verifyStick, hashFile } from "../dist/portable/integrity.js";
import { targetFor } from "../dist/portable/platform.js";
const exec = promisify(execFile), repo = process.env.GITHUB_REPOSITORY, runId = process.env.BUILD_RUN, variant = process.env.DMG_VARIANT;
const platform = targetFor(process.platform, process.arch);
if (!platform.startsWith("macos-") || !["full", "lite-picker"].includes(variant) || variant === "lite-picker" && platform !== "macos-x64" || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^\d+$/.test(runId ?? "")) { throw new Error("Invalid Mac DMG build parameters"); }
async function gh(...args) { return (await exec("gh", args, { maxBuffer: 4000000 })).stdout; }
const run = await successfulDesktopBuild(repo, runId, gh);
const cache = join(process.env.RUNNER_TEMP ?? tmpdir(), `stick-dmg-${runId}-${platform}`); await mkdir(cache, { recursive: true });
const disk = await statfs(cache), needed = (variant === "full" ? 44 : 13) * 1024 ** 3;
if (disk.bavail * disk.bsize < needed) { throw new Error(`DMG assembly needs ${needed / 1024 ** 3} GiB free; inspect the disk-preparation step`); }
const base = join(cache, "base"); await mkdir(base, { recursive: true });
let files = await readdir(base);
if (!files.length) { await gh("run", "download", runId, "--repo", repo, "--name", `stick_ai-base-${platform}`, "--dir", base); files = await readdir(base); }
if (files.length !== 1 || !files[0].endsWith(".zip")) { throw new Error("Unexpected verified Mac base artifact"); }
const temporary = await mkdtemp(join(cache, "image-")), staging = join(temporary, "contents"); await mkdir(staging);
try {
  await exec("unzip", ["-q", join(base, files[0]), "-d", staging]);
  const root = join(staging, "Stick AI"), original = await verifyStick(root, true);
  if (original.targets?.length !== 1 || original.targets[0] !== platform) { throw new Error("Wrong Mac architecture in the source build"); }
  const maxPath = variant === "full" ? await fetchMaxForRelease(join(temporary, "model-download")) : undefined;
  await prepareDmgModels(root, variant, maxPath);
  const expected = await verifyStick(root);
  await symlink("/Applications", join(staging, "Applications"));
  await writeFile(join(staging, "INSTALL FIRST.txt"), "Drag the entire Stick AI folder onto your USB stick or the Applications shortcut. Then open Stick AI.app inside that copied folder. Keep its files together. Copy the folder out of this read-only disk image before using the app.\n\n" + (variant === "full" ? "Both Lite and Max models are included. Choose Lite + Max on the welcome screen.\n" : "Lite is included. Use a Max file already on your stick opens the GGUF file picker; Max is linked without copying it.\n") + "App updates keep your models and projects. Max requires at least 16 GiB reported RAM; Lite requires 8 GiB. macOS 13.5 or newer is required.\n");
  const outputFolder = resolve("dmg-output"); await mkdir(outputFolder, { recursive: true });
  const name = `stick_ai-${platform}${variant === "lite-picker" ? "-lite-picker" : ""}.dmg`, output = join(outputFolder, name);
  await createMacDiskImage({ staging, temporary, output, verifyMounted: async (mounted) => {
    const actual = await verifyStick(mounted);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) { throw new Error("Mounted DMG manifest differs from its verified source"); }
    await exec(join(mounted, "Stick AI.app/Contents/MacOS/stick-ai"), ["--dry-run"]);
    if (!actual.files.some((record) => record.path === "app/stick-models.cjs")) { throw new Error("Mounted DMG lost the file picker helper"); }
  } });
  const metadata = { format: 1, repository: repo, run: runId, source: run.head_sha, platform, variant, name, ...await hashFile(output), models: expected.files.filter((record) => record.path.startsWith("models/")), checks: ["hdiutil verify", "read-only mounted file hashes", "native app dry-run", "Max file picker helper"] };
  await writeFile(output + ".json", JSON.stringify(metadata, null, 2) + "\n"); console.log(JSON.stringify(metadata));
} finally { await rm(temporary, { recursive: true, force: true }); }
