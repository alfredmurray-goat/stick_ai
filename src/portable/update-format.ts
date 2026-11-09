import { createPublicKey, verify } from "node:crypto";
import type { Manifest, FileRecord } from "./integrity.js";
import { targets, type Target } from "./platform.js";

export const updateMagic = Buffer.from("STICKUP1");
export const maxUpdateBytes = 512 * 1024 ** 2;
export interface UpdateConfig { format: 1; repository: string; target: Target; sequence: number; source: string }
export interface UpdateAsset { target: Target; name: string; sha256: string; size: number }
export interface UpdateFeed { format: 1; repository: string; sequence: number; source: string; assets: UpdateAsset[] }
export interface SignedFeed { payload: string; signature: string }
export function safeUpdatePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length < 1024 && !/[\\:\x00-\x1f\x7f]/.test(path) && path.split("/").every((part) => Boolean(part) && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function mutableUpdatePath(path: string): boolean {
  return ["models", "logs", "app/project", ".stick"].some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}
export function validateConfig(value: unknown): UpdateConfig {
  const config = value as UpdateConfig;
  if (!config || config.format !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !targets.includes(config.target) || !Number.isSafeInteger(config.sequence) || config.sequence < 0 || typeof config.source !== "string") { throw new Error("Invalid update configuration"); }
  return config;
}
export function verifyFeed(envelope: SignedFeed, publicKey: string, repository: string): UpdateFeed {
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string" || envelope.payload.length > 1000000) { throw new Error("Invalid signed update"); }
  const payload = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "base64");
  if (payload.toString("base64") !== envelope.payload || signature.length !== 64 || !verify(null, payload, createPublicKey(publicKey), signature)) { throw new Error("Update signature is invalid"); }
  const feed = JSON.parse(payload.toString("utf8")) as UpdateFeed;
  if (feed.format !== 1 || feed.repository !== repository || !Number.isSafeInteger(feed.sequence) || feed.sequence <= 0 || !/^[a-f0-9]{40}$/.test(feed.source) || !Array.isArray(feed.assets) || feed.assets.length !== targets.length) { throw new Error("Invalid update release"); }
  const seen = new Set<string>();
  for (const asset of feed.assets) {
    if (!targets.includes(asset.target) || seen.has(asset.target) || asset.name !== `stick_ai-update-${asset.target}.gz` || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxUpdateBytes) { throw new Error("Invalid update asset"); }
    seen.add(asset.target);
  }
  return feed;
}
export function validateUpdateManifest(value: unknown, target: Target): Manifest {
  const manifest = value as Manifest;
  if (!manifest || manifest.format !== 1 || !Array.isArray(manifest.targets) || manifest.targets.length !== 1 || manifest.targets[0] !== target || !Array.isArray(manifest.files) || manifest.files.length > 10000 || typeof manifest.nodeRelease !== "string" || typeof manifest.llamaRelease !== "string") { throw new Error("Update does not match this computer"); }
  const seen = new Set<string>(); let size = 0;
  for (const record of manifest.files) {
    if (!safeUpdatePath(record.path) || seen.has(record.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0 || typeof record.executable !== "boolean" || record.path === "manifest.json" || ["logs", "app/project", ".stick"].some((prefix) => record.path === prefix || record.path.startsWith(prefix + "/"))) { throw new Error("Unsafe update file"); }
    if (record.path.startsWith("models/") && !["models/stellan-1-lite-q4_k_m.gguf", "models/stellan-1-max-q4_k_m.gguf"].includes(record.path)) { throw new Error("Unexpected model file"); }
    seen.add(record.path.toLowerCase());
    if (!record.path.startsWith("models/")) { size += record.size; if (record.size > maxUpdateBytes || size > 2 * 1024 ** 3) { throw new Error("Update is too large"); } }
  }
  const desktop = target.startsWith("macos-") ? "Stick AI.app/Contents/MacOS/stick-ai" : target === "windows-x64" ? "Stick AI.exe" : "stick-ai";
  for (const path of [desktop, `bin/${target}/node${target === "windows-x64" ? ".exe" : ""}`, `bin/${target}/llama-server${target === "windows-x64" ? ".exe" : ""}`, "app/update-config.json", "app/stick-update.cjs", "app/launcher.cjs", "app/ui/index.html", "app/ui/main.js", "app/ui/style.css", "models/stellan-1-lite-q4_k_m.gguf"]) {
    if (!seen.has(path)) { throw new Error("Incomplete update"); }
  }
  return manifest;
}
export function sameRecord(a: FileRecord, b: FileRecord): boolean { return a.path === b.path && a.sha256 === b.sha256 && a.size === b.size; }
