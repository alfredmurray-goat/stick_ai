import { GiB } from "../config/models.js";

export const targets = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"] as const;
export type Target = typeof targets[number];
export const llamaRelease = "v0.9.0";
export const nodeRelease = "24.22.1";
export class UserError extends Error {
  constructor(readonly code: "unsupported" | "memory" | "damaged" | "busy" | "loading" | "browser" | "storage" | "general") { super(code); }
}
export function userMessage(error: unknown): string {
  const code = error instanceof UserError ? error.code : "general";
  return {
    unsupported: "This computer is not supported; try another computer.",
    memory: "Your computer needs at least 8 GB of memory; try a computer with more memory.",
    damaged: "This stick may be damaged; ask for a fresh copy.",
    busy: "Another app is using the connection; close other apps and try again.",
    loading: "The model could not start. Check the selected GGUF and available memory, or use Lite.",
    browser: "A browser could not open; choose a default browser and try again.",
    storage: "The stick cannot save its files; unlock the stick and try again.",
    general: "The assistant could not start; unplug the stick and plug it into a different port."
  }[code];
}
export function targetFor(platform: string, arch: string): Target {
  if (platform === "darwin" && arch === "arm64") { return "macos-arm64"; }
  if (platform === "darwin" && arch === "x64") { return "macos-x64"; }
  if (platform === "win32" && arch === "x64") { return "windows-x64"; }
  if (platform === "linux" && arch === "x64") { return "linux-x64"; }
  throw new UserError("unsupported");
}
export function portableModels(bytes: number, maxPresent: boolean): string[] {
  if (bytes < 8 * GiB) { throw new UserError("memory"); }
  return bytes >= 16 * GiB && maxPresent ? ["stellan-1-lite", "stellan-1-max"] : ["stellan-1-lite"];
}
export function modelFile(model: string): string {
  if (model === "stellan-1-lite") { return "models/stellan-1-lite-q4_k_m.gguf"; }
  if (model === "stellan-1-max") { return "models/stellan-1-max-q4_k_m.gguf"; }
  throw new UserError("damaged");
}
export function executableName(target: Target, node = false): string {
  return `${node ? "node" : "llama-server"}${target === "windows-x64" ? ".exe" : ""}`;
}
