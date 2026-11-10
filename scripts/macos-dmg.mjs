import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bundledMax } from "../src/portable/max-release.ts";
const exec = promisify(execFile);
import { imageCommand } from "./macos-image-command.mjs";
export async function prepareDmgModels(root, variant, maxPath, expectedMax = bundledMax) {
  if (!["full", "lite-picker"].includes(variant)) { throw new Error("Unknown DMG variant"); }
  const path = join(root, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  if (!manifest.files.some((record) => record.path === "app/stick-models.cjs")) { throw new Error("This build does not include the Max file picker"); }
  const maxRecord = manifest.files.find((record) => record.path === bundledMax.path);
  if (!maxRecord || maxRecord.sha256 !== expectedMax.sha256 || maxRecord.size !== expectedMax.size) { throw new Error("This base does not identify the pinned Max model"); }
  if (variant === "full") {
    if (!maxPath) { throw new Error("The full DMG needs the actual Max GGUF"); }
    await rename(maxPath, join(root, bundledMax.path));
  } else {
    await rm(join(root, bundledMax.path), { force: true });
    manifest.files = manifest.files.filter((record) => record.path !== bundledMax.path);
    await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  }
  return manifest;
}
export async function createMacDiskImage({ staging, temporary, output, verifyMounted }) {
  if (process.platform !== "darwin") { throw new Error("Real DMGs must be built and verified on macOS"); }
  const raw = join(temporary, "working-image.dmg"), compressed = join(temporary, "verified-image.dmg"), mount = join(temporary, "mounted");
  console.log("Creating native HFS+ disk image");
  await imageCommand(["create", "-ov", "-fs", "HFS+", "-volname", "Stick AI", "-format", "UDRW", "-srcfolder", staging, raw]);
  // Reclaim the source before converting, so there are never three full model copies.
  await rm(staging, { recursive: true, force: true });
  console.log("Converting to a compressed read-only DMG");
  await imageCommand(["convert", raw, "-format", "UDZO", "-imagekey", "zlib-level=1", "-ov", "-o", compressed]);
  await rm(raw);
  await exec("hdiutil", ["verify", compressed], { maxBuffer: 4000000 });
  await mkdir(mount); let attached = false;
  try {
    await imageCommand(["attach", "-readonly", "-nobrowse", "-mountpoint", mount, compressed]); attached = true;
    await verifyMounted(join(mount, "Stick AI"));
  } finally {
    if (attached) {
      try { await exec("hdiutil", ["detach", mount]); }
      catch { await exec("hdiutil", ["detach", "-force", mount]); }
    }
  }
  await rename(compressed, output);
}
