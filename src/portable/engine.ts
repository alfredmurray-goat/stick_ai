import { resolveLocalMax } from "./local-models.js";
import { writeSync } from "node:fs";
import { type ServerStatus } from "./progress.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { killProcessTree } from "../sandbox/process.js";
import { cleanEnvironment } from "../sandbox/backends.js";
import { Ollama } from "../model/ollama.js";
import { coderSystem } from "../agent/delegate.js";
import { ramStatus, type ModelName } from "../config/models.js";
import { reservePort } from "./ports.js";
import { executableName, modelFile, UserError, type Target } from "./platform.js";

export interface Switchable {
  stop(): Promise<void>;
  start(model: ModelName, signal: AbortSignal): Promise<void>;
}
export async function codeWithSwap(engine: Switchable, code: () => Promise<string>, signal: AbortSignal, report: (text: string) => void): Promise<string> {
  report("Switching to the coding model...");
  await engine.stop();
  try { await engine.start("stellan-1-max", signal); return await code(); }
  finally {
    await engine.stop();
    if (!signal.aborted) { await engine.start("stellan-1-lite", signal); }
  }
}
// Bound Mamba2 scratch buffers on 8 GB machines as well as hosted ARM runners.
// Smaller batches preserve the model and context while reducing peak working memory.
export function modelRuntimeArgs(model: ModelName): string[] {
  return model === "stellan-1-lite" ? ["--parallel", "1", "--no-repack", "--batch-size", "64", "--ubatch-size", "32", "--cache-ram", "0", "--no-cache-prompt", "--ctx-checkpoints", "0"] : ["--parallel", "1", "--no-repack", "--batch-size", "128", "--ubatch-size", "64", "--cache-ram", "0"];
}
export async function modelTemplateArgs(root: string, model: ModelName): Promise<string[]> {
  let templateArgs: string[] = [];
  try {
    const templates: unknown = JSON.parse(await readFile(join(root, "app/model-templates.json"), "utf8"));
    if (!templates || typeof templates !== "object" || Array.isArray(templates)) { throw new Error("Invalid model template configuration"); }
    const name = (templates as Record<string, unknown>)[model];
    if (name !== undefined) {
      if (name !== "mistral-v1") { throw new Error("Unsupported release chat template"); }
      templateArgs = ["--no-jinja", "--skip-chat-parsing", "--chat-template", name];
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
  return templateArgs;
}
export class ManagedEngine implements Switchable {
  child: ChildProcess | null = null;
  active: ModelName | null = null;
  disposing = false;
  contextSize = 8192;
  activeContextSize = 0;
  onOutput?: (text: string, thinking: boolean) => void;
  onModelStart?: () => void;
  onProcess?: (pid: number | null) => void;
  readonly key = randomBytes(32).toString("hex");
  constructor(readonly root: string, readonly target: Target, readonly port: number, private temp: string, private logFd: number, private log: (error: unknown) => void) {}
  get baseUrl(): string { return `http://127.0.0.1:${this.port}`; }
  async start(model: ModelName, signal: AbortSignal): Promise<void> {
    if (this.disposing) { throw new UserError("general"); }
    if (this.child) { throw new Error("A model process is already active"); }
    signal.throwIfAborted();
    const reservation = await reservePort(this.port, this.port); await reservation.release();
    const keyFile = join(this.temp, "server-key"); await writeFile(keyFile, this.key, { mode: 0o600 });
    const env = cleanEnvironment(this.temp, process.platform);
    env.HOME = this.temp; env.USERPROFILE = this.temp; env.TMPDIR = this.temp; env.TEMP = this.temp; env.TMP = this.temp;
    env.XDG_CACHE_HOME = this.temp; env.XDG_CONFIG_HOME = this.temp; env.XDG_DATA_HOME = this.temp;
    const templateArgs = await modelTemplateArgs(this.root, model);
    const max = model === "stellan-1-max" ? await resolveLocalMax(this.root) : undefined;
    if (model === "stellan-1-max" && !max) { throw new Error("Choose your Max GGUF before starting Max."); }
    const contextSize = model === "stellan-1-max" ? Math.min(this.contextSize, 4096) : this.contextSize;
    const child = spawn(join(this.root, "bin", this.target, executableName(this.target)), [
      "--model", max?.path ?? join(this.root, modelFile(model)), "--alias", model, "--ctx-size", String(contextSize),
      "--host", "127.0.0.1", "--port", String(this.port), "--api-key-file", keyFile,
      "--no-webui", "--no-warmup", "--gpu-layers", "0", ...modelRuntimeArgs(model), ...templateArgs
    ], { cwd: this.temp, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.onProcess?.(child.pid ?? null);
    for (const stream of [child.stdout, child.stderr]) { stream?.on("data", (data: Buffer) => { try { writeSync(this.logFd, data); } catch {} }); }
    let failed = false;
    child.once("error", (error) => { failed = true; this.log(error); });
    try {
      while (true) {
        signal.throwIfAborted();
        if (failed || child.exitCode !== null || child.signalCode !== null) { throw new UserError("loading"); }
        try {
          const health = await fetch(`${this.baseUrl}/health`, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
          const status = await health.json() as { status?: string };
          if (health.ok && status.status === "ok") {
            const valid = await fetch(`${this.baseUrl}/v1/models`, { redirect: "error", headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
            const invalid = await fetch(`${this.baseUrl}/v1/models`, { redirect: "error", headers: { Authorization: "Bearer invalid-startup-probe" }, signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
            const data = await valid.json() as { data?: { id: string }[] }; await invalid.body?.cancel();
            if (!valid.ok || invalid.status !== 401 || !data.data?.some((item) => item.id === model) || child.exitCode !== null) { throw new UserError("busy"); }
            this.active = model; this.activeContextSize = contextSize; return;
          }
        } catch (error) { if (error instanceof UserError) { throw error; } }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (error) { await this.stop(); throw error; }
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) { return; }
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (!exited && child.pid) {
      const closed = once(child, "close");
      await killProcessTree(child.pid, process.platform);
      await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Model process did not stop")), 5000).unref())]);
    }
    this.child = null; this.active = null; this.onProcess?.(null);
  }
  async status(): Promise<ServerStatus | undefined> {
    if (!this.child) { return undefined; }
    try {
      const headers = { Authorization: `Bearer ${this.key}` };
      const [health, slots] = await Promise.allSettled([
        fetch(`${this.baseUrl}/health`, { redirect: "error", headers, signal: AbortSignal.timeout(1000) }).then((response) => response.json()),
        fetch(`${this.baseUrl}/slots`, { redirect: "error", headers, signal: AbortSignal.timeout(1000) }).then(async (response) => response.ok ? response.json() : [])
      ]);
      return { ...(health.status === "fulfilled" ? health.value as ServerStatus : {}), slots: slots.status === "fulfilled" && Array.isArray(slots.value) ? slots.value : [] };
    } catch { return undefined; }
  }
  async code(task: string, context: string, signal: AbortSignal, report: (text: string) => void): Promise<string> {
    return codeWithSwap(this, async () => {
      const client = new Ollama("stellan-1-max", this.baseUrl, false, ramStatus(), { apiKey: this.key, specialist: true });
      this.onModelStart?.();
      const result = await client.complete([{ role: "system", content: coderSystem }, { role: "user", content: `Task:\n${task}\n\nRelevant source context:\n${context}` }], signal, (text, thinking) => this.onOutput?.(text, thinking));
      return result.content;
    }, signal, report);
  }
}
