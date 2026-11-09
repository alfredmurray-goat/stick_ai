import { createHash } from "node:crypto";
import { open, readFile, mkdir, mkdtemp, rm, rename, lstat, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hashFile, staticFiles, type Manifest } from "./integrity.js";
import { updatePublicKey } from "./update-key.js";
import { extractUpdateBundle } from "./update-package.js";
import { maxUpdateBytes, sameRecord, validateConfig, validateUpdateManifest, verifyFeed, type UpdateAsset, type UpdateConfig, type UpdateFeed, type SignedFeed } from "./update-format.js";

export interface UpdateResult { state: "available" | "current" | "offline" | "authentication" | "unsupported"; message: string; sequence?: number; bytes?: number }
interface ReleaseAsset { id: number; name: string; size: number }
interface Release { draft: boolean; assets: ReleaseAsset[] }
export interface AvailableUpdate { feed: UpdateFeed; envelope: SignedFeed; asset: UpdateAsset; download: ReleaseAsset }
const hosts = new Set(["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const validUrl = (url: URL): boolean => url.protocol === "https:" && hosts.has(url.hostname) && !url.port && !url.username && !url.password;
export async function githubResponse(url: string, token: string, signal: AbortSignal, accept = "application/vnd.github+json"): Promise<Response> {
  let next = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!validUrl(next)) { throw new Error("Untrusted update download host"); }
    const response = await fetch(next, { redirect: "manual", signal, headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "stick-ai-updater", ...(token && next.hostname === "api.github.com" ? { Authorization: `Bearer ${token}` } : {}) } });
    if (![301, 302, 303, 307, 308].includes(response.status)) { return response; }
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location) { throw new Error("Missing update redirect"); } next = new URL(location, next);
  }
  throw new Error("Too many update redirects");
}
async function jsonResponse(response: Response, limit = 2000000): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error([401, 403, 404].includes(response.status) ? "UPDATE_AUTH" : "UPDATE_NETWORK"); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const item = await reader.read(); if (item.done) { break; } size += item.value.length; if (size > limit) { throw new Error("Update metadata too large"); } chunks.push(item.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function readUpdateConfig(root: string): Promise<UpdateConfig> {
  const path = join(root, "app/update-config.json"); const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 10000) { throw new Error("Invalid update configuration"); }
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
export async function findUpdate(config: UpdateConfig, token: string, signal: AbortSignal, publicKey = updatePublicKey): Promise<AvailableUpdate | undefined> {
  const api = `https://api.github.com/repos/${config.repository}`;
  const releases = await jsonResponse(await githubResponse(`${api}/releases?per_page=20`, token, signal));
  if (!Array.isArray(releases)) { throw new Error("Invalid update releases"); }
  let latest: AvailableUpdate | undefined;
  for (const release of releases as Release[]) {
    if (release.draft || !Array.isArray(release.assets)) { continue; }
    const asset = release.assets.find((item) => item.name === "stick_ai-updates.json");
    if (!asset || !Number.isSafeInteger(asset.id)) { continue; }
    const envelope = await jsonResponse(await githubResponse(`${api}/releases/assets/${asset.id}`, token, signal, "application/octet-stream")) as SignedFeed;
    const feed = verifyFeed(envelope, publicKey, config.repository);
    if (feed.sequence <= config.sequence || feed.source === config.source) { continue; }
    const selected = feed.assets.find((item) => item.target === config.target)!;
    const download = release.assets.find((item) => item.name === selected.name && Number.isSafeInteger(item.id) && item.size === selected.size);
    if (!download) { throw new Error("Incomplete app update"); }
    if (!latest || feed.sequence > latest.feed.sequence) { latest = { feed, envelope, asset: selected, download }; }
  }
  return latest;
}
export async function checkForUpdate(root: string, token: string, signal: AbortSignal): Promise<UpdateResult> {
  try {
    const config = await readUpdateConfig(root); const update = await findUpdate(config, token, signal);
    return update ? { state: "available", sequence: update.feed.sequence, bytes: update.asset.size, message: "An app update is ready. Your models and projects stay here." } : { state: "current", message: "Your app is up to date." };
  } catch (error) {
    if (error instanceof Error && error.message === "UPDATE_AUTH") { return { state: "authentication", message: "GitHub access is needed for private updates. Add a read-only token below." }; }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { return { state: "unsupported", message: "This copy needs a new platform-specific download once to enable updates." }; }
    return { state: "offline", message: "Updates could not be checked. You can keep using the app offline." };
  }
}
async function downloadBundle(config: UpdateConfig, update: AvailableUpdate, token: string, path: string, signal: AbortSignal): Promise<void> {
  const response = await githubResponse(`https://api.github.com/repos/${config.repository}/releases/assets/${update.download.id}`, token, signal, "application/octet-stream");
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("App update download failed"); }
  const file = await open(path, "wx", 0o600); const hash = createHash("sha256"); let size = 0; const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read(); if (item.done) { break; }
      size += item.value.length; if (size > update.asset.size || size > maxUpdateBytes) { throw new Error("App update exceeds its signed size"); }
      hash.update(item.value); await file.writeFile(item.value);
    }
    await file.sync();
  } finally { await file.close(); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (size !== update.asset.size || hash.digest("hex") !== update.asset.sha256) { throw new Error("App update checksum failed"); }
}
async function safeDirectory(path: string): Promise<boolean> {
  try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) { throw new Error("Unsafe application data directory"); } return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { return false; } throw error; }
}
async function preserveInstalledMax(root: string, manifest: Manifest): Promise<Manifest> {
  const current = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  const max = current.files.find((record) => record.path === "models/stellan-1-max-q4_k_m.gguf");
  if (max && !manifest.files.some((record) => record.path === max.path)) { return { ...manifest, files: [...manifest.files, max] }; }
  return manifest;
}
async function compatibleModels(root: string, manifest: Manifest): Promise<void> {
  const current = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  const before = current.files.filter((record) => record.path.startsWith("models/"));
  const after = manifest.files.filter((record) => record.path.startsWith("models/"));
  if (!before.every((old) => after.some((record) => sameRecord(old, record))) || !after.every((record) => before.some((old) => sameRecord(old, record)) || record.path === "models/stellan-1-max-q4_k_m.gguf" && record.optional === true)) { throw new Error("This update requires different models. Keep this version or download a complete package."); }
  if (!await safeDirectory(join(root, "models"))) { throw new Error("The installed models are missing"); }
}
export async function prepareUpdate(rootPath: string, token: string, signal: AbortSignal, publicKey = updatePublicKey): Promise<string> {
  const root = await realpath(rootPath); const config = await readUpdateConfig(root);
  const update = await findUpdate(config, token, signal, publicKey); if (!update) { throw new Error("No newer update is available"); }
  const work = await mkdtemp(join(dirname(root), `.${basename(root)}.update-`));
  try {
    const next = join(work, "next"); await mkdir(next);
    await downloadBundle(config, update, token, join(work, "download.gz"), signal);
    const manifest = await preserveInstalledMax(root, await extractUpdateBundle(join(work, "download.gz"), next, config.target, signal));
    await writeFile(join(next, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const nextConfig = await readUpdateConfig(next);
    if (nextConfig.repository !== config.repository || nextConfig.sequence !== update.feed.sequence || nextConfig.source !== update.feed.source || nextConfig.target !== config.target) { throw new Error("App update identity mismatch"); }
    await compatibleModels(root, manifest);
    for (const relative of ["app/project", "logs"]) { await safeDirectory(join(root, relative)); }
    await writeFile(join(work, "signed-feed.json"), JSON.stringify(update.envelope), { mode: 0o600 });
    return work;
  } catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
}
async function verifyTree(root: string, manifest: Manifest, models: boolean): Promise<void> {
  if (JSON.stringify(JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))) !== JSON.stringify(manifest)) { throw new Error("Changed update manifest"); }
  const records = manifest.files.filter((record) => models || !record.path.startsWith("models/"));
  for (const record of records) {
    const path = join(root, record.path);
    let info; try { info = await lstat(path); } catch (error) { if (record.optional && record.path.startsWith("models/") && (error as NodeJS.ErrnoException).code === "ENOENT") { continue; } throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path) { throw new Error("Unsafe staged update"); }
    const actual = await hashFile(path);
    if (actual.size !== record.size || actual.sha256 !== record.sha256 || process.platform !== "win32" && record.executable && !(info.mode & 0o111)) { throw new Error("Changed staged update"); }
  }
  const expected = new Set(records.map((record) => record.path));
  for (const file of await staticFiles(root)) { if (!expected.has(file)) { throw new Error("Unlisted staged update file"); } }
}
export async function applyPreparedUpdate(rootPath: string, workPath: string, publicKey = updatePublicKey): Promise<void> {
  const root = await realpath(rootPath), work = await realpath(workPath);
  if (dirname(root) !== dirname(work) || !basename(work).startsWith(`.${basename(root)}.update-`) || !await safeDirectory(work)) { throw new Error("Unsafe update staging directory"); }
  const lock = join(dirname(root), `.${basename(root)}.update-lock`); await mkdir(lock, { mode: 0o700 });
  const previous = join(work, "previous"), next = join(work, "next"); const moved: string[] = []; let backedUp = false; let installed = false;
  try {
    const config = await readUpdateConfig(root);
    const feed = verifyFeed(JSON.parse(await readFile(join(work, "signed-feed.json"), "utf8")), publicKey, config.repository);
    if (feed.sequence <= config.sequence) { throw new Error("Refusing an older app update"); }
    const asset = feed.assets.find((item) => item.target === config.target)!;
    const bundle = await hashFile(join(work, "download.gz")); if (bundle.sha256 !== asset.sha256 || bundle.size !== asset.size) { throw new Error("Changed update download"); }
    const inspection = join(work, "inspection"); await mkdir(inspection);
    const manifest = await preserveInstalledMax(root, await extractUpdateBundle(join(work, "download.gz"), inspection, config.target, new AbortController().signal));
    await rm(inspection, { recursive: true });
    await compatibleModels(root, manifest); await verifyTree(next, manifest, false);
    const nextConfig = await readUpdateConfig(next);
    if (nextConfig.sequence !== feed.sequence || nextConfig.source !== feed.source || nextConfig.repository !== config.repository || nextConfig.target !== config.target) { throw new Error("App update identity mismatch"); }
    await rename(root, previous); backedUp = true;
    for (const path of ["models", "app/project", "logs"]) {
      if (await safeDirectory(join(previous, path))) {
        await mkdir(dirname(join(next, path)), { recursive: true });
        await rename(join(previous, path), join(next, path)); moved.push(path);
      } else if (path !== "models") { await mkdir(join(next, path), { recursive: true }); }
    }
    await verifyTree(next, manifest, true);
    await rename(next, root); installed = true;
    await writeFile(join(work, "rollback.json"), JSON.stringify({ root, previous, installed: feed.sequence }) + "\n");
    await rm(join(work, "download.gz"));
  } catch (error) {
    if (backedUp && !installed) {
      for (const path of moved.reverse()) { await rename(join(next, path), join(previous, path)); }
      await rename(previous, root);
    }
    throw error;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
