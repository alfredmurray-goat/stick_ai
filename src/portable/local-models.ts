import { constants } from "node:fs";
import { lstat, open, readFile, realpath, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir, totalmem } from "node:os";
import { modelFile } from "./platform.js";

interface ModelLink { format: 1; path: string; relative: boolean; size: number; mtimeMs: number }
export interface LocalMax { path: string; source: "linked" | "bundled"; name: string }
export interface LocalModelStatus { available: boolean; eligible: boolean; totalBytes: number; name?: string; path?: string; source?: string; message: string }
export class LocalModelError extends Error {}
const configName = "max-model.json";
async function logsDirectory(root: string): Promise<string> {
  const path = join(root, "logs"); await mkdir(path, { recursive: true });
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) { throw new LocalModelError("The app's settings folder is unsafe."); }
  return path;
}
export async function inspectMaxFile(path: string): Promise<{ path: string; size: number; mtimeMs: number; dev: number }> {
  if (!path.toLowerCase().endsWith(".gguf") || /[\x00-\x1f]/.test(path)) { throw new LocalModelError("Choose a single Stellan-1 Max .gguf file."); }
  const canonical = await realpath(path).catch(() => { throw new LocalModelError("The Max model file is missing. Reconnect the stick or choose the file again."); });
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(); const header = Buffer.alloc(24); const { bytesRead } = await file.read(header, 0, 24, 0);
    if (!info.isFile() || info.nlink !== 1 || info.size < 24 || bytesRead !== 24 || header.toString("ascii", 0, 4) !== "GGUF" || ![2, 3].includes(header.readUInt32LE(4)) || header.readBigUInt64LE(8) === 0n) { throw new LocalModelError("This is not a complete GGUF model. Choose your single Max GGUF file."); }
    return { path: canonical, size: info.size, mtimeMs: info.mtimeMs, dev: info.dev };
  } finally { await file.close(); }
}
export async function resolveLocalMax(rootPath: string): Promise<LocalMax | undefined> {
  const root = await realpath(rootPath); const settings = join(root, "logs", configName);
  let text: string | undefined;
  try {
    await logsDirectory(root); const info = await lstat(settings);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384) { throw new LocalModelError("The saved Max selection is invalid. Choose your file again."); }
    text = await readFile(settings, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
  if (text !== undefined) {
    let config: ModelLink;
    try { config = JSON.parse(text) as ModelLink; } catch { throw new LocalModelError("The saved Max selection is invalid. Choose your file again."); }
    if (!config || config.format !== 1 || typeof config.path !== "string" || typeof config.relative !== "boolean" || !Number.isSafeInteger(config.size) || !Number.isFinite(config.mtimeMs) || config.relative && isAbsolute(config.path) || !config.relative && !isAbsolute(config.path)) { throw new LocalModelError("The saved Max selection is invalid. Choose your file again."); }
    const file = await inspectMaxFile(config.relative ? resolve(root, config.path) : config.path);
    if (file.size !== config.size || Math.abs(file.mtimeMs - config.mtimeMs) > 1) { throw new LocalModelError("The selected Max file has changed. Choose it again to confirm the new file."); }
    return { path: file.path, source: "linked", name: basename(file.path) };
  }
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { files?: { path: string }[] };
  if (!manifest.files?.some((file) => file.path === modelFile("stellan-1-max"))) { return undefined; }
  const bundled = join(root, modelFile("stellan-1-max"));
  try { await stat(bundled); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { return undefined; } throw error; }
  return { path: bundled, source: "bundled", name: basename(bundled) };
}
export async function linkMaxFile(rootPath: string, path: string): Promise<void> {
  const root = await realpath(rootPath);
  const input = path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : resolve(root, path);
  const file = await inspectMaxFile(input); const rel = relative(root, file.path);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { files: { path: string }[] };
    if (!manifest.files.some((entry) => resolve(root, entry.path) === file.path)) { throw new LocalModelError("Keep your Max GGUF outside the app folder, for example beside it on your stick, then choose it here. No copy is needed."); }
  }
  const portable = (await stat(root)).dev === file.dev && !isAbsolute(rel);
  const config: ModelLink = { format: 1, path: portable ? rel : file.path, relative: portable, size: file.size, mtimeMs: file.mtimeMs };
  const logs = await logsDirectory(root); const temporary = join(logs, `.max-model-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(config) + "\n"); await handle.sync(); await handle.close(); await rename(temporary, join(logs, configName)); }
  finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}
export async function unlinkMaxFile(rootPath: string): Promise<void> { const root = await realpath(rootPath); await rm(join(await logsDirectory(root), configName), { force: true }); }
export async function localModelStatus(root: string, bytes = totalmem()): Promise<LocalModelStatus> {
  try {
    const model = await resolveLocalMax(root); const eligible = bytes >= 16 * 1024 ** 3;
    return { available: Boolean(model), eligible, totalBytes: bytes, ...(model ? { name: model.name, path: model.path, source: model.source } : {}), message: model ? eligible ? `${model.source === "bundled" ? "Lite and Max are included" : "Max linked: " + model.name}. Lite + Max is ready.` : `${model.source === "bundled" ? "Lite and Max are included" : "Max linked: " + model.name}. Max needs at least 16 GiB RAM; use Lite on this computer.` : "Lite is included. Choose the Max GGUF already on your stick to enable Max in this same app." };
  } catch (error) { return { available: false, eligible: bytes >= 16 * 1024 ** 3, totalBytes: bytes, source: "linked", message: error instanceof LocalModelError ? error.message : "The Max model could not be read. Choose the file again or continue with Lite." }; }
}
