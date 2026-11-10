import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, link, readFile } from "node:fs/promises";
import { join } from "node:path";
import { bundledMax, maxRelease } from "../src/portable/max-release.ts";
const exec = promisify(execFile);
export async function fetchMaxForRelease(directory) {
  await mkdir(directory, { recursive: true }); const output = join(directory, "stellan-1-max-q4_k_m.gguf"), temporary = output + ".part";
  const file = await open(temporary, "wx", 0o600); await file.close();
  try {
    console.log("Downloading the pinned Max GGUF once for all four complete packages");
    await exec("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--retry-all-errors", "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "120", "--output", temporary, "--", maxRelease.url], { maxBuffer: 1000000 });
    const hash = createHash("sha256"); let size = 0;
    for await (const bytes of createReadStream(temporary)) { hash.update(bytes); size += bytes.length; }
    if (size !== bundledMax.size || hash.digest("hex") !== bundledMax.sha256) { throw new Error("Max model integrity check failed"); }
    await rename(temporary, output); return output;
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
export async function assembleFullRelease(baseArchive, folder, platform, maxPath, expectedMax = bundledMax, verifier) {
  const extract = join(folder, "extracted"); await mkdir(extract);
  if (baseArchive.endsWith(".tar.gz")) { await exec("tar", ["-xzf", baseArchive, "-C", extract]); }
  else { await exec("unzip", ["-q", baseArchive, "-d", extract]); }
  await rm(baseArchive);
  const root = join(extract, "Stick AI");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const record = manifest.files.find((file) => file.path === expectedMax.path);
  if (!record || record.sha256 !== expectedMax.sha256 || record.size !== expectedMax.size) { throw new Error("Base package does not identify the verified Max model"); }
  await link(maxPath, join(root, expectedMax.path));
  const verifyPackage = verifier ?? (await import("../dist/portable/integrity.js")).verifyStick;
  await verifyPackage(root, false, undefined, true);
  const output = join(folder, `stick_ai-${platform}.${platform === "linux-x64" ? "tar.gz" : "zip"}`);
  if (platform === "linux-x64") { await exec("tar", ["-czf", output, "-C", extract, "Stick AI"], { env: { ...process.env, GZIP: "-1" }, maxBuffer: 1000000 }); }
  else { await exec("zip", ["-q", "-0", "-r", output, "Stick AI"], { cwd: extract, maxBuffer: 1000000 }); }
  await rm(extract, { recursive: true, force: true });
  return output;
}
