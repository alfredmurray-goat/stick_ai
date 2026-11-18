import { resolveLocalModel } from "./local-models.js";
import { writeSync } from "node:fs";
import { type ServerStatus } from "./progress.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { totalmem } from "node:os";
import { killProcessTree } from "../sandbox/process.js";
import { cleanEnvironment } from "../sandbox/backends.js";
import { Ollama } from "../model/ollama.js";
import { coderSystem } from "../agent/delegate.js";
import { ramStatus, type ModelName } from "../config/models.js";
import { reservePort } from "./ports.js";
import { executableName, UserError, type Target } from "./platform.js";

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
// Lite keeps its prompt cache so each agent step only processes the new tokens.
// Mamba2 state cannot be rewound, so one context checkpoint (~0.3 GB measured on
// the release Lite at 8192 context) lets the slot roll back to the end of the
// previous prompt instead of reprocessing the whole conversation every step.
// Measured on 4 CPU cores: a follow-up step fell from ~95 s to ~5 s; peak memory
// rose from 4.16 to 4.47 GB. 512/256 batches read prompts ~20% faster than 64/32
// for +0.06 GB. RAM prompt caching across conversations stays off (--cache-ram 0).
export function modelRuntimeArgs(model: ModelName): string[] {
  return model === "stellan-1-lite" ? ["--parallel", "1", "--no-repack", "--batch-size", "512", "--ubatch-size", "256", "--cache-ram", "0", "--ctx-checkpoints", "1"] : ["--parallel", "1", "--no-repack", "--batch-size", "128", "--ubatch-size", "64", "--cache-ram", "0"];
}
// Apple Silicon builds include the Metal GPU backend. Weights are memory-mapped and
// shared with the GPU, but macOS caps GPU working memory at roughly two thirds of RAM,
// so Max (14.3 GB) only offloads on Macs with at least 24 GiB. Every other target, and
// STICK_GPU=0, stays CPU-only. ManagedEngine falls back to the CPU if a GPU start fails.
// macOS virtual machines only expose a paravirtual Metal device, which loads the model but
// runs it many times slower than the CPU (a CI tool exchange went from ~5 to 30+ minutes),
// so Macs running as virtual machines stay on the CPU too.
export function gpuLayerArgs(target: Target, model: ModelName, totalBytes: number, env: NodeJS.ProcessEnv = process.env, virtualMachine = false): string[] {
  const gpu = target === "macos-arm64" && env.STICK_GPU !== "0" && !virtualMachine && (model === "stellan-1-lite" || totalBytes >= 24 * 1024 ** 3);
  return ["--gpu-layers", gpu ? "999" : "0"];
}
let virtualMac: boolean | undefined;
export function isVirtualMac(): boolean {
  if (process.platform !== "darwin") { return false; }
  if (virtualMac === undefined) {
    try { virtualMac = execFileSync("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8", timeout: 2000 }).trim() === "1"; }
    catch { virtualMac = false; }
  }
  return virtualMac;
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
  gpuFailed = false;
  detectVirtualMachine: () => boolean = isVirtualMac;
  async start(model: ModelName, signal: AbortSignal): Promise<void> {
    const gpu = this.gpuFailed ? ["--gpu-layers", "0"] : gpuLayerArgs(this.target, model, totalmem(), process.env, this.detectVirtualMachine());
    try { await this.launch(model, signal, gpu); }
    catch (error) {
      // A GPU that cannot load the model (driver, memory or unsupported operation) must not
      // leave the user without a model: retry once on the CPU and keep it for this session.
      if (gpu[1] === "0" || signal.aborted || this.disposing || !(error instanceof UserError) || !["loading", "busy"].includes(error.code)) { throw error; }
      this.gpuFailed = true; this.log(new Error(`GPU start failed for ${model}; retrying on the CPU`));
      await this.launch(model, signal, ["--gpu-layers", "0"]);
    }
  }
  private async launch(model: ModelName, signal: AbortSignal, gpu: string[]): Promise<void> {
    if (this.disposing) { throw new UserError("general"); }
    if (this.child) { throw new Error("A model process is already active"); }
    signal.throwIfAborted();
    // Resolve the model file first so a missing Lite or Max is reported before any port or process work.
    const selected = await resolveLocalModel(this.root, model === "stellan-1-max" ? "max" : "lite");
    if (model === "stellan-1-max" && !selected) { throw new Error("Choose your Max GGUF before starting Max."); }
    if (!selected) { throw new UserError("nomodel"); }
    const reservation = await reservePort(this.port, this.port); await reservation.release();
    const keyFile = join(this.temp, "server-key"); await writeFile(keyFile, this.key, { mode: 0o600 });
    const env = cleanEnvironment(this.temp, process.platform);
    env.HOME = this.temp; env.USERPROFILE = this.temp; env.TMPDIR = this.temp; env.TEMP = this.temp; env.TMP = this.temp;
    env.XDG_CACHE_HOME = this.temp; env.XDG_CONFIG_HOME = this.temp; env.XDG_DATA_HOME = this.temp;
    const templateArgs = await modelTemplateArgs(this.root, model);
    const contextSize = model === "stellan-1-max" ? Math.min(this.contextSize, 4096) : this.contextSize;
    const child = spawn(join(this.root, "bin", this.target, executableName(this.target)), [
      "--model", selected.path, "--alias", model, "--ctx-size", String(contextSize),
      "--host", "127.0.0.1", "--port", String(this.port), "--api-key-file", keyFile,
      "--no-webui", "--no-warmup", ...gpu, ...modelRuntimeArgs(model), ...templateArgs
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
