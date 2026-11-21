import { lockedModels, type LockedModel } from "./locked-models.js";
import { lockedNames } from "./model-lock.js";
import { GiB, maxMinimumBytes, maxRecommendedBytes, maxSlowWarning } from "../config/models.js";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir, totalmem } from "node:os";
import { modelFile } from "./platform.js";

// Both models can be bundled in the app folder or linked by path from elsewhere on the
// stick. A linked file takes precedence; model-free downloads rely on links for both.
export type ModelKind = "lite" | "max";
interface ModelLink { format: 1; path: string; relative: boolean; size: number; mtimeMs: number }
/** `locked`: the stick carries the model as an encrypted first split plus a plain rest (model-lock.ts). */
export interface LocalModel { path: string; source: "linked" | "bundled"; name: string; locked?: { file: string; model: LockedModel } }
export type LocalMax = LocalModel;
export interface LiteStatus { available: boolean; name?: string; path?: string; source?: string; message: string }
export interface LocalModelStatus { available: boolean; eligible: boolean; slow: boolean; slowMessage: string; totalBytes: number; name?: string; path?: string; source?: string; message: string; lite: LiteStatus }
export class LocalModelError extends Error {}
const label = { lite: "Lite", max: "Max" } as const;
const configName = (kind: ModelKind): string => `${kind}-model.json`;
const bundledPath = (kind: ModelKind): string => modelFile(kind === "lite" ? "stellan-1-lite" : "stellan-1-max");
export function modelKind(value: unknown): ModelKind {
  if (value === "lite" || value === "max") { return value; }
  throw new LocalModelError("Choose Lite or Max.");
}
async function logsDirectory(root: string): Promise<string> {
  const path = join(root, "logs"); await mkdir(path, { recursive: true });
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) { throw new LocalModelError("The app's settings folder is unsafe."); }
  return path;
}
export async function inspectModelFile(path: string, kind: ModelKind): Promise<{ path: string; size: number; mtimeMs: number; dev: number }> {
  const name = label[kind];
  if (!path.toLowerCase().endsWith(".gguf") || /[\x00-\x1f]/.test(path)) { throw new LocalModelError(`Choose a single Stellan-1 ${name} .gguf file.`); }
  const canonical = await realpath(path).catch(() => { throw new LocalModelError(`The ${name} model file is missing. Reconnect the stick or choose the file again.`); });
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(); const header = Buffer.alloc(24); const { bytesRead } = await file.read(header, 0, 24, 0);
    if (!info.isFile() || info.nlink !== 1 || info.size < 24 || bytesRead !== 24 || header.toString("ascii", 0, 4) !== "GGUF" || ![2, 3].includes(header.readUInt32LE(4)) || header.readBigUInt64LE(8) === 0n) { throw new LocalModelError(`This is not a complete GGUF model. Choose your single ${name} GGUF file.`); }
    return { path: canonical, size: info.size, mtimeMs: info.mtimeMs, dev: info.dev };
  } finally { await file.close(); }
}
export const inspectMaxFile = (path: string) => inspectModelFile(path, "max");
export async function resolveLocalModel(rootPath: string, kind: ModelKind): Promise<LocalModel | undefined> {
  const root = await realpath(rootPath); const settings = join(root, "logs", configName(kind)); const name = label[kind];
  let text: string | undefined;
  try {
    await logsDirectory(root); const info = await lstat(settings);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384) { throw new LocalModelError(`The saved ${name} selection is invalid. Choose your file again.`); }
    text = await readFile(settings, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
  if (text !== undefined) {
    let config: ModelLink;
    try { config = JSON.parse(text) as ModelLink; } catch { throw new LocalModelError(`The saved ${name} selection is invalid. Choose your file again.`); }
    if (!config || config.format !== 1 || typeof config.path !== "string" || typeof config.relative !== "boolean" || !Number.isSafeInteger(config.size) || !Number.isFinite(config.mtimeMs) || config.relative && isAbsolute(config.path) || !config.relative && !isAbsolute(config.path)) { throw new LocalModelError(`The saved ${name} selection is invalid. Choose your file again.`); }
    const file = await inspectModelFile(config.relative ? resolve(root, config.path) : config.path, kind);
    if (file.size !== config.size || Math.abs(file.mtimeMs - config.mtimeMs) > 1) { throw new LocalModelError(`The selected ${name} file has changed. Choose it again to confirm the new file.`); }
    return { path: file.path, source: "linked", name: basename(file.path) };
  }
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { files?: { path: string }[] };
  const listed = (path: string): boolean => Boolean(manifest.files?.some((file) => file.path === path));
  const present = async (path: string): Promise<boolean> => { try { await stat(join(root, path)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { return false; } throw error; } };
  if (listed(bundledPath(kind)) && await present(bundledPath(kind))) { const bundled = join(root, bundledPath(kind)); return { path: bundled, source: "bundled", name: basename(bundled) }; }
  const locked = lockedModels[kind === "lite" ? "stellan-1-lite" : "stellan-1-max"]; const names = lockedNames(locked.base);
  if (listed(names.locked) && listed(names.rest) && await present(names.locked) && await present(names.rest)) {
    return { path: join(root, names.rest), source: "bundled", name: basename(bundledPath(kind)), locked: { file: join(root, names.locked), model: locked } };
  }
  return undefined;
}
export const resolveLocalMax = (root: string) => resolveLocalModel(root, "max");
export async function linkModelFile(rootPath: string, kind: ModelKind, path: string): Promise<void> {
  const root = await realpath(rootPath);
  const input = path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : resolve(root, path);
  const file = await inspectModelFile(input, kind); const rel = relative(root, file.path);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { files: { path: string }[] };
    if (!manifest.files.some((entry) => resolve(root, entry.path) === file.path)) { throw new LocalModelError(`Keep your ${label[kind]} GGUF outside the app folder, for example beside it on your stick, then choose it here. No copy is needed.`); }
  }
  const portable = (await stat(root)).dev === file.dev && !isAbsolute(rel);
  const config: ModelLink = { format: 1, path: portable ? rel : file.path, relative: portable, size: file.size, mtimeMs: file.mtimeMs };
  const logs = await logsDirectory(root); const temporary = join(logs, `.${kind}-model-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(config) + "\n"); await handle.sync(); await handle.close(); await rename(temporary, join(logs, configName(kind))); }
  finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}
export const linkMaxFile = (root: string, path: string) => linkModelFile(root, "max", path);
export async function unlinkModelFile(rootPath: string, kind: ModelKind): Promise<void> { const root = await realpath(rootPath); await rm(join(await logsDirectory(root), configName(kind)), { force: true }); }
export const unlinkMaxFile = (root: string) => unlinkModelFile(root, "max");
async function liteStatus(root: string): Promise<LiteStatus> {
  try {
    const model = await resolveLocalModel(root, "lite");
    if (!model) { return { available: false, message: "This download has no model files. Choose your Stellan-1 Lite GGUF to start." }; }
    return { available: true, name: model.name, path: model.path, source: model.source, message: model.source === "bundled" ? "Lite is included." : `Lite linked: ${model.name}.` };
  } catch (error) { return { available: false, source: "linked", message: error instanceof LocalModelError ? error.message : "The Lite model could not be read. Choose the file again." }; }
}
export async function localModelStatus(root: string, bytes = totalmem()): Promise<LocalModelStatus> {
  const lite = await liteStatus(root); const eligible = bytes >= maxMinimumBytes; const slow = eligible && bytes < maxRecommendedBytes; const slowMessage = slow ? maxSlowWarning(Math.floor(bytes / GiB * 100) / 100) : "";
  try {
    const model = await resolveLocalMax(root);
    const maxText = model ? model.source === "bundled" ? "Max is included" : `Max linked: ${model.name}` : "";
    const message = !lite.available ? lite.message
      : model ? eligible ? slow ? `${lite.message} ${maxText}, but it may be very slow on this computer (24 GB of memory recommended). Lite is the default here.` : `${lite.message} ${maxText}. Lite + Max is ready.` : `${lite.message} ${maxText}. Max needs at least 16 GB of memory; use Lite on this computer.`
      : `${lite.message} Choose the Max GGUF already on your stick to enable Max in this same app.`;
    return { available: Boolean(model), eligible, slow, slowMessage, totalBytes: bytes, ...(model ? { name: model.name, path: model.path, source: model.source } : {}), message, lite };
  } catch (error) { return { available: false, eligible, slow, slowMessage, totalBytes: bytes, source: "linked", message: error instanceof LocalModelError ? error.message : "The Max model could not be read. Choose the file again or continue with Lite.", lite }; }
}
