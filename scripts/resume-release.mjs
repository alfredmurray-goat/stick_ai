import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);
export const releasePlatforms = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"];
export function archiveName(platform) { return `stick_ai-${platform}.${platform === "linux-x64" ? "tar.gz" : "zip"}`; }
export function helperName(platform) { return `Join-stick_ai-${platform}.${platform === "windows-x64" ? "bat" : platform === "linux-x64" ? "sh.zip" : "command.zip"}`; }
export function recordFromHelper(platform, text, assets) {
  if (!releasePlatforms.includes(platform) || typeof text !== "string" || text.length > 100000) { return undefined; }
  const name = archiveName(platform), hashes = new Map();
  const pattern = platform === "windows-x64" ? /Get-FileHash -LiteralPath '([^']+)' -Algorithm SHA256\)\.Hash -ne '([a-f0-9]{64})'/g : /check '([^']+)' '([a-f0-9]{64})' \|\| fail/g;
  for (const match of text.matchAll(pattern)) {
    if (hashes.has(match[1])) { return undefined; } hashes.set(match[1], match[2]);
  }
  const sha256 = hashes.get(name + ".joining"); if (!sha256) { return undefined; }
  hashes.delete(name + ".joining");
  if (!hashes.size || hashes.size > 99) { return undefined; }
  const parts = []; let size = 0;
  for (let index = 0; index < hashes.size; index++) {
    const partName = `${name}.part${String(index + 1).padStart(2, "0")}`, hash = hashes.get(partName);
    const found = assets.find((asset) => asset.name === partName);
    if (!hash || !found || found.state !== "uploaded" || found.digest !== `sha256:${hash}` || !Number.isSafeInteger(found.size) || found.size <= 0 || found.size > 2000 * 1024 ** 2 || index + 1 < hashes.size && found.size !== 2000 * 1024 ** 2) { return undefined; }
    parts.push({ name: partName, size: found.size, sha256: hash }); size += found.size;
  }
  const uploadedParts = assets.filter((asset) => asset.name.startsWith(name + ".part"));
  if (uploadedParts.length !== parts.length) { return undefined; }
  return { name, size, sha256, parts };
}
export async function completedReleasePlatforms(repo, tag, source, temporary, gh) {
  const view = JSON.parse(await gh("release", "view", tag, "--repo", repo, "--json", "apiUrl,targetCommitish,isDraft"));
  const prefix = `https://api.github.com/repos/${repo}/releases/`;
  if (!view.isDraft || view.targetCommitish !== source || !view.apiUrl.startsWith(prefix) || !/^\d+$/.test(view.apiUrl.slice(prefix.length))) { throw new Error("Refusing to resume a different or published release"); }
  const release = JSON.parse(await gh("api", view.apiUrl)); const records = new Map();
  for (const platform of releasePlatforms) {
    const name = helperName(platform), asset = release.assets.find((item) => item.name === name && item.state === "uploaded");
    if (!asset) { continue; }
    const folder = join(temporary, `resume-${platform}`); await mkdir(folder);
    await gh("release", "download", tag, "--repo", repo, "--pattern", name, "--dir", folder);
    const path = join(folder, name), bytes = await readFile(path);
    if (asset.digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`) { continue; }
    // Read the known helper as data; never execute downloaded shell or PowerShell code.
    const text = name.endsWith(".zip") ? (await exec("unzip", ["-p", path, name.slice(0, -4)], { maxBuffer: 1000000 })).stdout : bytes.toString("utf8");
    const record = recordFromHelper(platform, text, release.assets);
    if (record) { records.set(platform, record); console.log(`Reusing verified completed platform: ${platform}`); }
  }
  return records;
}
