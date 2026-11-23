import { optionalModelPaths } from "./locked-models.js";
import { createPublicKey, verify } from "node:crypto";
import type { Manifest, FileRecord } from "./integrity.js";
import { targets, type Target } from "./platform.js";

export const updateMagic = Buffer.from("STICKUP1");
export const maxUpdateBytes = 512 * 1024 ** 2;
// Sticks are sold with private builds, so app updates come from a private host rather than public
// GitHub releases. The feed is Ed25519-signed and every bundle is checked by size and SHA-256, so the
// host only has to be reachable, not trusted.
export const defaultUpdateFeed = "https://updates.localilabs.com/stick-ai/stick_ai-updates.json";
// A stick made for every computer carries all four platforms; its updates use the "universal" bundle.
export type UpdateTarget = Target | "universal";
export const updateTargets: readonly UpdateTarget[] = [...targets, "universal"];
export interface UpdateConfig { format: 1; repository: string; target: UpdateTarget; sequence: number; source: string; feed?: string }
export function validFeedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) { return false; }
  try { const url = new URL(value); return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith("/stick_ai-updates.json"); }
  catch { return false; }
}
export interface UpdateAsset { target: UpdateTarget; name: string; sha256: string; size: number }
export interface UpdateFeed { format: 1; repository: string; sequence: number; source: string; assets: UpdateAsset[] }
export interface SignedFeed { payload: string; signature: string }
export function safeUpdatePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length < 1024 && !/[\\:<>"|?*\x00-\x1f\x7f]/.test(path) && path.split("/").every((part) => Boolean(part) && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function validateConfig(value: unknown): UpdateConfig {
  const config = value as UpdateConfig;
  if (!config || config.format !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !updateTargets.includes(config.target) || !Number.isSafeInteger(config.sequence) || config.sequence < 0 || typeof config.source !== "string" || (config.feed !== undefined && !validFeedUrl(config.feed))) { throw new Error("Invalid update configuration"); }
  return config;
}
export function verifyFeed(envelope: SignedFeed, publicKey: string, repository: string): UpdateFeed {
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string" || envelope.payload.length > 1000000) { throw new Error("Invalid signed update"); }
  const payload = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "base64");
  if (payload.toString("base64") !== envelope.payload || signature.length !== 64 || !verify(null, payload, createPublicKey(publicKey), signature)) { throw new Error("Update signature is invalid"); }
  const feed = JSON.parse(payload.toString("utf8")) as UpdateFeed;
  if (feed.format !== 1 || feed.repository !== repository || !Number.isSafeInteger(feed.sequence) || feed.sequence <= 0 || !/^[a-f0-9]{40}$/.test(feed.source) || !Array.isArray(feed.assets) || ![targets.length, updateTargets.length].includes(feed.assets.length)) { throw new Error("Invalid update release"); }
  const seen = new Set<string>();
  for (const asset of feed.assets) {
    if (!updateTargets.includes(asset.target) || seen.has(asset.target) || asset.name !== `stick_ai-update-${asset.target}.gz` || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxUpdateBytes) { throw new Error("Invalid update asset"); }
    seen.add(asset.target);
  }
  if (targets.some((target) => !seen.has(target))) { throw new Error("Invalid update release"); }
  return feed;
}
export function validateUpdateManifest(value: unknown, target: UpdateTarget): Manifest {
  const manifest = value as Manifest;
  if (!manifest || manifest.format !== 1 || !Array.isArray(manifest.targets) || (target === "universal" ? manifest.targets.length !== targets.length || targets.some((item) => !manifest.targets!.includes(item)) : manifest.targets.length !== 1 || manifest.targets[0] !== target) || !Array.isArray(manifest.files) || manifest.files.length > 10000 || typeof manifest.nodeRelease !== "string" || typeof manifest.llamaRelease !== "string") { throw new Error("Update does not match this computer"); }
  const seen = new Set<string>(); let size = 0;
  for (const record of manifest.files) {
    if (!safeUpdatePath(record.path) || seen.has(record.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0 || typeof record.executable !== "boolean" || record.path === "manifest.json" || ["logs", "app/project", ".stick"].some((prefix) => record.path === prefix || record.path.startsWith(prefix + "/"))) { throw new Error("Unsafe update file"); }
    if (record.path.startsWith("models/") && !optionalModelPaths.has(record.path)) { throw new Error("Unexpected model file"); }
    seen.add(record.path.toLowerCase());
    if (!record.path.startsWith("models/")) { size += record.size; if (record.size > maxUpdateBytes || size > 2 * 1024 ** 3) { throw new Error("Update is too large"); } }
  }
  const platforms = target === "universal" ? [...targets] : [target];
  const required = new Set(["README.txt", "app/update-config.json", "app/stick-update.cjs", "app/launcher.cjs", "app/ui/index.html", "app/ui/main.js", "app/ui/style.css", "models/stellan-1-lite-q4_k_m.gguf"]);
  for (const platform of platforms) {
    const windows = platform === "windows-x64";
    required.add(platform.startsWith("macos-") ? "Stick AI.app/Contents/MacOS/stick-ai" : windows ? "Stick AI.exe" : "stick-ai");
    required.add(platform.startsWith("macos-") ? "Start.command" : windows ? "Start.bat" : "start.sh");
    required.add(`bin/${platform}/node${windows ? ".exe" : ""}`); required.add(`bin/${platform}/llama-server${windows ? ".exe" : ""}`);
  }
  if (manifest.runtime !== undefined && manifest.runtime !== "stellan-run") throw new Error("Unknown update runtime");
  if (manifest.runtime === "stellan-run") {
    required.add("app/stick-engine.cjs");
    for (const platform of platforms) required.add(`bin/${platform}/stellan-run${platform === "windows-x64" ? ".exe" : ""}`);
  }
  for (const path of required) {
    if (!seen.has(path.toLowerCase())) { throw new Error("Incomplete update"); }
  }
  return manifest;
}
export function sameRecord(a: FileRecord, b: FileRecord): boolean { return a.path === b.path && a.sha256 === b.sha256 && a.size === b.size; }
