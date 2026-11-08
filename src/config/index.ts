import { mkdir, readFile, writeFile } from "node:fs/promises";
import { modelName, type ModelName } from "./models.js";
import { Sandbox } from "../sandbox/paths.js";

export interface Config { model: ModelName; baseUrl: string; maxSteps: number }
export const defaults: Config = { model: "stellan-1-lite", baseUrl: "http://localhost:11434", maxSteps: 20 };
export function endpoint(value: string, remote: boolean): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("Base URL must be an HTTP(S) origin, optionally ending in /v1");
  }
  if (!remote && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Remote endpoint refused; explicitly pass --allow-remote");
  }
  if (url.hostname === "localhost") { url.hostname = "127.0.0.1"; }
  return `${url.origin}/v1/chat/completions`;
}
export async function loadConfig(box: Sandbox, remote: boolean): Promise<Config> {
  let stored: Partial<Omit<Config, "model">> & { model?: string } = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(await box.path(".stick/config.json", true), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { throw new Error("Config must be an object"); }
    stored = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
  }
  const config = { ...defaults, ...stored, model: process.env.STICK_MODEL ?? (stored.model === "stellan-1.0" ? defaults.model : stored.model) ?? defaults.model, baseUrl: process.env.STICK_BASE_URL ?? stored.baseUrl ?? defaults.baseUrl };
  if (typeof config.model !== "string" || !config.model.trim() || typeof config.baseUrl !== "string" || !Number.isInteger(config.maxSteps) || config.maxSteps < 1 || config.maxSteps > 1000) {
    throw new Error("Invalid config: model/baseUrl strings and maxSteps integer 1..1000 required");
  }
  endpoint(config.baseUrl, remote);
  return { ...config, model: modelName(config.model) };
}
export async function initConfig(box: Sandbox): Promise<void> {
  await mkdir(await box.path(".stick", true), { recursive: true, mode: 0o700 });
  await writeFile(await box.path(".stick/config.json", true), JSON.stringify(defaults, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
