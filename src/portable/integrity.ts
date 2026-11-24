import { lockedModelPaths, optionalModelPaths } from "./locked-models.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Sandbox } from "../sandbox/paths.js";
import { UserError, llamaRelease, nodeRelease, targets, type Target } from "./platform.js";

/** `locked`: an encrypted model split; its size is checked here and its decrypted sha256 when it's unlocked. */
export interface FileRecord { path: string; sha256: string; size: number; executable: boolean; optional?: boolean; locked?: boolean }
export interface Manifest { format: 1; llamaRelease: string; nodeRelease: string; runtime?: "stellan-run"; nativeHost?: true; targets?: Target[]; files: FileRecord[] }
export async function hashFile(path: string, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) { size += chunk.length; hash.update(chunk); }
  return { sha256: hash.digest("hex"), size };
}
export async function staticFiles(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    if ([".DS_Store", "Thumbs.db", "desktop.ini", ".Spotlight-V100", ".Trashes", ".fseventsd", "System Volume Information", "$RECYCLE.BIN"].includes(item.name) || item.name.startsWith("._")) { continue; }
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (path === "logs" || path === "app/project" || path === "manifest.json") { continue; }
    if (item.isSymbolicLink() || !item.isDirectory() && !item.isFile()) { throw new UserError("damaged"); }
    if (item.isDirectory()) { result.push(...await staticFiles(root, path)); } else { result.push(path); }
  }
  return result.sort();
}
// Hashing both models (about 18 GB) on every start took one to three minutes from a USB stick. A model
// file whose size and modification time match its last full check is trusted; anything else (programs,
// app files, a model that changed) is hashed every time. The cache lives in logs/, outside the manifest.
const cacheName = "logs/verified-models.json";
const cacheMin = 64 * 1024 ** 2;
type VerifiedModels = Record<string, { sha256: string; size: number; mtimeMs: number }>;
async function readVerified(root: string): Promise<VerifiedModels> {
  try { const value = JSON.parse(await readFile(join(root, cacheName), "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value as VerifiedModels : {}; }
  catch { return {}; }
}
/** `remember` is for the running app only: builds must never ship a "models already checked" note. */
export async function verifyStick(root: string, optionalMax = false, signal?: AbortSignal, allowBuildModelLinks = false, remember = false): Promise<Manifest> {
  try {
    const canonical = await realpath(root);
    const box = await Sandbox.create(root);
    await box.path("logs", true); await box.path("app/project", true);
    const verified = remember ? await readVerified(root) : {}; const nowVerified: VerifiedModels = {};
    const manifestInfo = await lstat(join(root, "manifest.json"));
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 4000000) { throw new UserError("damaged"); }
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
    if (manifest.format !== 1 || manifest.llamaRelease !== llamaRelease || manifest.nodeRelease !== nodeRelease || !Array.isArray(manifest.files)) { throw new UserError("damaged"); }
    const selected = manifest.targets ?? [...targets];
    if (!Array.isArray(selected) || !selected.length || selected.some((target) => !targets.includes(target)) || new Set(selected).size !== selected.length) { throw new UserError("damaged"); }
    const launchers = [...new Set(selected.map((target) => target.startsWith("macos-") ? "Start.command" : target === "windows-x64" ? "Start.bat" : "start.sh"))];
    const expected = new Set<string>();
    const issues: string[] = [];
    for (const record of manifest.files) {
      if (typeof record.path !== "string" || !record.path || record.path.split("/").some((part) => !part || part === "." || part === "..") || /[\\:]/.test(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.executable !== "boolean" || !Number.isSafeInteger(record.size) || record.size < 0 || expected.has(record.path)) { throw new UserError("damaged"); }
      expected.add(record.path);
      const path = join(root, record.path);
      try {
      let info;
      try { info = await lstat(path); } catch (error) {
        // Optional model files may be absent (model-free downloads link their own GGUFs);
        // a present model file must still match its recorded hash.
        // A stick carries each model plain or locked, so the locked layout's files may always be absent.
        if (record.optional && optionalModelPaths.has(record.path) && (optionalMax || lockedModelPaths.has(record.path)) && (error as NodeJS.ErrnoException).code === "ENOENT") { continue; }
        throw error;
      }
      const resolved = await realpath(path);
      const rel = relative(canonical, resolved);
      if (rel.split(sep)[0] === ".." || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 && !(allowBuildModelLinks && record.path === "models/stellan-1.0-q4_k_m.gguf")) { throw new UserError("damaged"); }
      if (record.locked) { if (info.size !== record.size) { issues.push(`Changed file: ${record.path}`); } continue; }
      const known = verified[record.path];
      const reuse = record.path.startsWith("models/") && record.size >= cacheMin && known && known.sha256 === record.sha256 && known.size === info.size && known.mtimeMs === info.mtimeMs;
      const actual = reuse ? { sha256: record.sha256, size: info.size } : await hashFile(path, signal);
      if (record.path.startsWith("models/") && record.size >= cacheMin && actual.sha256 === record.sha256 && actual.size === record.size) { nowVerified[record.path] = { sha256: actual.sha256, size: actual.size, mtimeMs: info.mtimeMs }; }
      if (actual.sha256 !== record.sha256 || actual.size !== record.size || process.platform !== "win32" && record.executable && !(info.mode & 0o111)) { issues.push(`Changed file: ${record.path}`); }
      } catch (error) { if (signal?.aborted) { throw error; } issues.push(`Missing or unsafe file: ${record.path}: ${String(error)}`); }
    }
    for (const path of await staticFiles(root)) { if (!expected.has(path)) { issues.push(`Unlisted or missing file: ${path}`); } }
    for (const path of [...launchers, "README.txt", "app/launcher.cjs", "app/ui/index.html", "app/ui/main.js", "app/ui/style.css", "models/stellan-1-lite-q4_k_m.gguf", ...selected.flatMap((target) => [`bin/${target}/node${target === "windows-x64" ? ".exe" : ""}`, `bin/${target}/llama-server${target === "windows-x64" ? ".exe" : ""}`])]) {
      if (!expected.has(path)) { issues.push(`Unlisted or missing file: ${path}`); }
    }
    if (manifest.runtime !== undefined && manifest.runtime !== "stellan-run") issues.push("Unknown runtime");
    if (manifest.runtime === "stellan-run") {
      for (const path of ["app/stick-engine.cjs", ...selected.map(target => `bin/${target}/stellan-run${target === "windows-x64" ? ".exe" : ""}`)]) if (!expected.has(path)) issues.push(`Missing Stellan-Run file: ${path}`);
    }
    if (manifest.nativeHost !== undefined) {
      if (manifest.nativeHost !== true) issues.push("Unknown native host");
      for (const target of selected) {
        const path = `bin/${target}/stellan-host${target === "windows-x64" ? ".exe" : ""}`;
        if (!manifest.files.some(record => record.path === path && record.executable && !record.optional)) issues.push(`Missing native host: ${path}`);
      }
    }
    if (issues.length) { const error = new UserError("damaged"); error.message = `damaged: ${issues.join("; ")}`; throw error; }
    if (remember && JSON.stringify(nowVerified) !== JSON.stringify(verified)) {
      // Best effort: a read-only stick still starts, it just checks the models in full next time too.
      try { const temporary = join(root, `${cacheName}.${process.pid}.tmp`); await writeFile(temporary, JSON.stringify(nowVerified) + "\n"); await rename(temporary, join(root, cacheName)); } catch {}
    }
    return manifest;
  } catch (error) { if (error instanceof UserError) { throw error; } const failure = new UserError("damaged"); failure.message = `damaged: ${String(error)}`; throw failure; }
}
