import { startStellanServer } from "../../portable/stellan-server.mjs";
import { type Manifest } from "./integrity.js";
import { lockedNames, ModelLockError, unlockModel } from "./model-lock.js";
import { resolveLocalModel } from "./local-models.js";
import { writeSync, createReadStream } from "node:fs";
import { type ServerStatus } from "./progress.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { totalmem } from "node:os";
import { killProcessTree } from "../sandbox/process.js";
import { cleanEnvironment } from "../sandbox/backends.js";
import { Ollama } from "../model/ollama.js";
import { coderSystem } from "../agent/delegate.js";
import { ramStatus, type ModelName } from "../config/models.js";
import { reservePort } from "./ports.js";
import { executableName, UserError, type Target } from "./platform.js";

// Space on the computer. Stick AI keeps everything on the stick; the only things it writes to this computer
// are a temporary folder (the unlocked first part of a locked model, ~80 MB each) and two optional speed
// caches of Lite's reading state (~0.5 GB each). Below `diskComfortable` free the caches are skipped, so the
// app still works in about 300 MB: new conversations and Lite → Max swaps just re-read a little more.
export const diskMinimum = 300 * 1024 ** 2;
export const diskComfortable = 1536 * 1024 ** 2;
export async function freeBytes(path: string): Promise<number | undefined> {
  try { const info = await statfs(path); return info.bavail * info.bsize; } catch { return undefined; }
}
export interface Switchable {
  stop(): Promise<void>;
  start(model: ModelName, signal: AbortSignal): Promise<void>;
  /** Saves Lite's prompt cache before the swap; false if it couldn't. */
  saveLiteCache?(): Promise<boolean>;
  /** Loads it back after Lite restarts so the conversation isn't read again. */
  restoreLiteCache?(): Promise<boolean>;
}
// Only one model fits in memory, so Max replaces Lite while it writes code. Restarting Lite used to lose its
// prompt cache and make it re-read the whole conversation (2,020 tokens took 81 s on 4 CPU cores). Saving
// Lite's slot first and restoring it afterwards left 48 tokens to read (3 s); save and restore took ~0.25 s each.
export async function codeWithSwap(engine: Switchable, code: () => Promise<string>, signal: AbortSignal, report: (text: string) => void): Promise<string> {
  report("Switching to the coding model...");
  const saved = await engine.saveLiteCache?.().catch(() => false) ?? false;
  await engine.stop();
  try { await engine.start("stellan-1-max", signal); return await code(); }
  finally {
    await engine.stop();
    if (!signal.aborted) {
      await engine.start("stellan-1-lite", signal);
      if (saved) { await engine.restoreLiteCache?.().catch(() => false); }
    }
  }
}
// Lite keeps its prompt cache so each agent step only processes the new tokens.
// Mamba2 state cannot be rewound, so one context checkpoint (~0.3 GB measured on
// the release Lite at 8192 context) lets the slot roll back to the end of the
// previous prompt instead of reprocessing the whole conversation every step.
// Measured on 4 CPU cores: a follow-up step fell from ~95 s to ~5 s; peak memory
// rose from 4.16 to 4.47 GB. 512/256 batches read prompts ~20% faster than 64/32
// for +0.06 GB. RAM prompt caching across conversations stays off (--cache-ram 0).
//
// Max: an 8-bit attention cache (needs flash attention) halves the memory its context costs, and
// n-gram speculative decoding drafts tokens it has already seen. Rewriting a 25-function file on
// 4 CPU cores went from 4.3 to 12.4 tokens/s with identical greedy output, and plain prose was
// unchanged. Lite stays without it: its tool calls carry file text JSON-escaped, so drafts from the
// source rarely match (5 of 144 accepted, ~5% slower). `plain` drops these extras for the fallback.
export function modelRuntimeArgs(model: ModelName, plain = false): string[] {
  if (model === "stellan-1-lite") { return ["--parallel", "1", "--no-repack", "--batch-size", "512", "--ubatch-size", "256", "--cache-ram", "0", "--ctx-checkpoints", "1"]; }
  return ["--parallel", "1", "--no-repack", "--batch-size", "128", "--ubatch-size", "64", "--cache-ram", "0", ...(plain ? [] : ["--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--spec-type", "ngram-simple"])];
}
/** How much each model may see at once, and how much of the conversation the app keeps word for word. */
export interface ContextPlan { lite: number; max: number; historyBytes: number; projectBytes: number }
// Lite is a pure Mamba2 model: its memory of the conversation is a fixed-size state, so a larger
// window costs no RAM (measured 8.0 GB resident at both 8,192 and 131,072 tokens). What a long
// conversation does cost is time if it ever has to be read again from the start, so the app keeps
// about 12k tokens word for word and summarises older tasks (compactHistory); Long context mode keeps
// about 100k. Max stores every token (about 80 KB each with the 8-bit cache). Normal stays at 8k;
// the optional Long window follows RAM instead of consuming the savings by default.
export function contextPlan(totalBytes: number, long = false): ContextPlan {
  const GiB = 1024 ** 3;
  const max = long ? (totalBytes >= 30 * GiB ? 65536 : totalBytes >= 22 * GiB ? 32768 : 16384) : 8192;
  return long ? { lite: 262144, max, historyBytes: 393216, projectBytes: 32768 } : { lite: 65536, max, historyBytes: 49152, projectBytes: 8192 };
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
// With 32 GB or more, Max stays loaded beside Lite after its first job, so a handoff costs neither
// stopping Lite nor reloading either model from the stick. Lite (~8 GB at its default window) plus
// Max (~14.3 GB of weights and up to ~2.6 GB of 8-bit cache) need about 25 GB. A Mac that puts both
// on the GPU needs more, because macOS lets the GPU use only about two thirds of memory.
export function keepsBothLoaded(target: Target, totalBytes: number, env: NodeJS.ProcessEnv = process.env, virtualMachine = false): boolean {
  const GiB = 1024 ** 3;
  if (env.STICK_KEEP_BOTH === "0") { return false; }
  const metal = gpuLayerArgs(target, "stellan-1-max", totalBytes, env, virtualMachine)[1] !== "0";
  return totalBytes >= (metal ? 46 : 30) * GiB;
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
  /** Context sizes for this computer and mode; `faster` (the low-memory fallback) caps them at 4,096. */
  plan: ContextPlan = contextPlan(totalmem());
  faster = false;
  /** Set when Max would not start with its speed settings; it then runs without them for the session. */
  plainFallback = false;
  activeContextSize = 0;
  onOutput?: (text: string, thinking: boolean) => void;
  onModelStart?: () => void;
  onUsage?: (model: ModelName, tokens: number) => void;
  onProcess?: (pid: number | null) => void;
  readonly key = randomBytes(32).toString("hex");
  /** A second engine that keeps Max loaded beside Lite (see keepsBothLoaded); stopped with this one. */
  coder: ManagedEngine | undefined;
  /** The activation's key for a locked model on this stick (see model-lock.ts). */
  modelKey: ((model: ModelName) => Buffer | undefined) | undefined;
  constructor(readonly root: string, readonly target: Target, readonly port: number, private temp: string, private logFd: number, private log: (error: unknown) => void) {}
  get baseUrl(): string { return `http://127.0.0.1:${this.port}`; }
  private nativeServer: Awaited<ReturnType<typeof startStellanServer>> | undefined;
  nativeRuntime = false;
  gpuFailed = false;
  detectVirtualMachine: () => boolean = isVirtualMac;
  async start(model: ModelName, signal: AbortSignal): Promise<void> {
    const gpu = this.gpuFailed ? ["--gpu-layers", "0"] : gpuLayerArgs(this.target, model, totalmem(), process.env, this.detectVirtualMachine());
    try { await this.launch(model, signal, gpu); }
    catch (error) {
      if (this.nativeRuntime) { throw error; }
      if (gpu[1] === "0") { await this.retryPlain(model, signal, error); return; }
      // A GPU that cannot load the model (driver, memory or unsupported operation) must not
      // leave the user without a model: retry once on the CPU and keep it for this session.
      if (gpu[1] === "0" || signal.aborted || this.disposing || !(error instanceof UserError) || !["loading", "busy"].includes(error.code)) { throw error; }
      this.gpuFailed = true; this.log(new Error(`GPU start failed for ${model}; retrying on the CPU`));
      try { await this.launch(model, signal, ["--gpu-layers", "0"]); }
      catch (again) { await this.retryPlain(model, signal, again); }
    }
  }
  // Max's speed settings depend on the llama.cpp build; if Max will not start with them, start it once more without.
  private async retryPlain(model: ModelName, signal: AbortSignal, error: unknown): Promise<void> {
    if (model !== "stellan-1-max" || this.plainFallback || signal.aborted || this.disposing || !(error instanceof UserError) || !["loading", "busy"].includes(error.code)) { throw error; }
    this.plainFallback = true; this.log(new Error("Max did not start with its speed settings; retrying without them"));
    await this.launch(model, signal, ["--gpu-layers", "0"]);
  }
  private async launch(model: ModelName, signal: AbortSignal, gpu: string[]): Promise<void> {
    if (this.disposing) { throw new UserError("general"); }
    if (this.child) { throw new Error("A model process is already active"); }
    signal.throwIfAborted();
    // Resolve the model file first so a missing Lite or Max is reported before any port or process work.
    const selected = await resolveLocalModel(this.root, model === "stellan-1-max" ? "max" : "lite");
    if (model === "stellan-1-max" && !selected) { throw new Error("Choose your Max GGUF before starting Max."); }
    if (!selected) { throw new UserError("nomodel"); }
    const manifest = JSON.parse(await readFile(join(this.root, "manifest.json"), "utf8").catch(error => { if (error.code === "ENOENT") return "{\"files\":[]}"; throw error; })) as Manifest;
    this.nativeRuntime = manifest.runtime === "stellan-run";
    const reservation = await reservePort(this.port, this.port); await reservation.release();
    const keyFile = join(this.temp, "server-key"); await writeFile(keyFile, this.key, { mode: 0o600 });
    // Lite's slot is saved here (the computer's temp folder, not the stick) while Max runs; see codeWithSwap.
    const slots = join(this.temp, "slots"); if (model === "stellan-1-lite") { await mkdir(slots, { recursive: true, mode: 0o700 }); }
    const env = cleanEnvironment(this.temp, process.platform);
    env.HOME = this.temp; env.USERPROFILE = this.temp; env.TMPDIR = this.temp; env.TEMP = this.temp; env.TMP = this.temp;
    env.XDG_CACHE_HOME = this.temp; env.XDG_CONFIG_HOME = this.temp; env.XDG_DATA_HOME = this.temp;
    // A locked model's first split is decrypted into this computer's temporary folder once per session;
    // llama.cpp (patched) reads the rest straight from the stick via LLAMA_SPLIT_DIR.
    let modelPath = selected.path;
    if (selected.locked) {
      const key = this.modelKey?.(model);
      if (!key) { throw new ModelLockError("Activate this stick to use its models. Restart the app and enter the code from the box."); }
      const names = lockedNames(basename(selected.locked.model.base)); const unlocked = join(this.temp, "unlocked");
      modelPath = join(unlocked, names.first);
      if (!await stat(modelPath).then((info) => info.size === selected.locked!.model.firstSize, () => false)) {
        await unlockModel(selected.locked.file, unlocked, names.first, key, selected.locked.model.label);
        const digest = createHash("sha256").update(await readFile(modelPath)).digest("hex");
        if (digest !== selected.locked.model.firstSha256) { await rm(modelPath, { force: true }); throw new UserError("damaged"); }
      }
      env.LLAMA_SPLIT_DIR = dirname(selected.path);
    }
    const templateArgs = await modelTemplateArgs(this.root, model);
    const planned = model === "stellan-1-max" ? this.plan.max : this.plan.lite;
    const contextSize = this.faster ? Math.min(planned, 4096) : planned;
    let child: ChildProcess;
    if (this.nativeRuntime) {
      const enginePath = `bin/${this.target}/stellan-run${this.target === "windows-x64" ? ".exe" : ""}`;
      const binary = manifest.files.find(file => file.path === enginePath);
      if (!binary) throw new UserError("damaged");
      const primary = selected.locked?.model.firstSha256 ?? (selected.source === "bundled" ? manifest.files.find(file => file.path === relative(this.root, selected.path).split(sep).join("/"))?.sha256 : await this.modelHash(modelPath, signal));
      if (!primary) throw new UserError("damaged");
      delete env.LLAMA_SPLIT_DIR;
      try {
        this.nativeServer = await startStellanServer({ executable: join(this.root, enginePath), executableSha256: binary.sha256, model: modelPath, sha256: primary, modelName: model, key: this.key, port: this.port, context: contextSize, signal, threads: 2, kvCache: model === "stellan-1-max" ? "q8_0" : "f16", environment: env, ...(selected.locked ? { splitModel: selected.path, splitSha256: selected.locked.model.restSha256 } : {}), onProcess: process => { this.child = process; this.onProcess?.(process.pid ?? null); } });
      } catch (error) { await this.stop(); throw error; }
      if (!this.child) throw new UserError("loading");
      child = this.child;
    } else child = spawn(join(this.root, "bin", this.target, executableName(this.target)), [
      "--model", modelPath, "--alias", model, "--ctx-size", String(contextSize),
      "--host", "127.0.0.1", "--port", String(this.port), "--api-key-file", keyFile,
      "--no-webui", "--no-warmup", ...gpu, ...modelRuntimeArgs(model, this.plainFallback), ...templateArgs, ...(model === "stellan-1-lite" ? ["--slot-save-path", slots] : [])
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
  private async modelHash(path: string, signal: AbortSignal): Promise<string> {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
    return hash.digest("hex");
  }
  async stop(): Promise<void> {
    await this.coder?.stop();
    if (this.nativeServer) {
      const server = this.nativeServer; this.nativeServer = undefined;
      await server.close(); this.child = null; this.active = null; this.onProcess?.(null); return;
    }
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
  private async slotAction(action: "save" | "restore", filename = "lite-cache.bin"): Promise<boolean> {
    if (action === "save") { const free = await freeBytes(this.temp); if (free !== undefined && free < diskComfortable) { return false; } }
    try {
      const response = await fetch(`${this.baseUrl}/slots/0?action=${action}`, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ filename }), signal: AbortSignal.timeout(120000) });
      await response.body?.cancel(); return response.ok;
    } catch (error) { this.log(error); return false; }
  }
  async saveLiteCache(): Promise<boolean> { return this.active === "stellan-1-lite" && this.child ? this.slotAction("save") : false; }
  async restoreLiteCache(): Promise<boolean> {
    const restored = this.active === "stellan-1-lite" && this.child ? await this.slotAction("restore") : false;
    // The file is about half a gigabyte; it's only needed for this one swap.
    await rm(join(this.temp, "slots", "lite-cache.bin"), { force: true }).catch(() => undefined);
    return restored;
  }
  private warmed = "";
  // Reads the session's system message into Lite's prompt cache while the user is still typing, so
  // the first answer only reads the task itself. Measured on 4 CPU cores: an 851-token system message
  // took 35 s once; the request after it read 19 new tokens (3.7 s instead of ~40 s). The template is
  // rendered by the server itself and cut just before the user's words, so the cached tokens are an
  // exact prefix of every real request. The read state is saved so a new conversation can start
  // from it again in a fraction of a second instead of reading it all again.
  async warm(system: string, signal: AbortSignal): Promise<boolean> {
    if (this.active !== "stellan-1-lite" || !this.child) { return false; }
    try {
      const post = async (path: string, body: unknown): Promise<unknown> => {
        const response = await fetch(`${this.baseUrl}${path}`, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Model server ${path} failed with HTTP ${response.status}`); }
        return response.json();
      };
      const mark = "\u0001STICK_TASK\u0001";
      const rendered = await post("/apply-template", { messages: [{ role: "system", content: system }, { role: "user", content: mark }] }) as { prompt?: unknown };
      const at = typeof rendered.prompt === "string" ? rendered.prompt.indexOf(mark) : -1;
      if (at <= 0) { return false; }
      await post("/completion", { prompt: (rendered.prompt as string).slice(0, at), n_predict: 0, cache_prompt: true });
      if (!await this.slotAction("save", "system-cache.bin")) { return false; }
      this.warmed = system; return true;
    } catch (error) { if (!signal.aborted) { this.log(error); } return false; }
  }
  /** Puts Lite back to the state right after reading `system`; false if that state wasn't saved. */
  async restoreSystem(system: string): Promise<boolean> {
    return this.active === "stellan-1-lite" && this.child && this.warmed === system ? this.slotAction("restore", "system-cache.bin") : false;
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
    const write = async (server: ManagedEngine): Promise<string> => {
      const client = new Ollama("stellan-1-max", server.baseUrl, false, ramStatus(), { apiKey: server.key, specialist: true, onUsage: (tokens) => this.onUsage?.("stellan-1-max", tokens) });
      this.onModelStart?.();
      const result = await client.complete([{ role: "system", content: coderSystem }, { role: "user", content: `Task:\n${task}\n\nRelevant source context:\n${context}` }], signal, (text, thinking) => this.onOutput?.(text, thinking));
      return result.content;
    };
    const coder = await this.loadedCoder(signal, report);
    return coder ? write(coder) : codeWithSwap(this, () => write(this), signal, report);
  }
  /** Max running beside Lite, started on first use; undefined when this computer swaps them instead. */
  async loadedCoder(signal: AbortSignal, report: (text: string) => void): Promise<ManagedEngine | undefined> {
    const coder = this.coder;
    if (!coder || coder.active === "stellan-1-max") { return coder; }
    report("Loading the coding model. It stays loaded, so later handoffs start at once...");
    coder.faster = this.faster; coder.plan = this.plan;
    try { await coder.start("stellan-1-max", signal); return coder; }
    catch (error) {
      // Not enough memory after all, or another failure: swap the models for the rest of the session.
      if (signal.aborted) { throw error; }
      this.log(error); this.coder = undefined; await coder.stop().catch(this.log);
      return undefined;
    }
  }
}
