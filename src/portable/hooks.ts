import { appFetch } from "./net.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { killProcessTree } from "../sandbox/process.js";
import { shellArguments } from "../sandbox/backends.js";
import { readExtensionJson, writeExtensionJson } from "./extension-store.js";

// Hooks run the user's own commands, or tell a local app (for example a voice assistant), when
// something happens: modelled on Claude Code's hooks. They are added in Settings → Hooks only, never
// read from a project folder, so a downloaded project can't make the app run anything.
// A hook can block a message or a tool call, or add notes for Stellan. It can never approve a file
// change, command or MCP call: approvals still happen in the app.
export const hookEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"] as const;
export type HookEvent = typeof hookEvents[number];
export interface HookConfig { id: string; name: string; event: HookEvent; matcher: string; type: "command" | "http"; command?: string; url?: string; timeout: number; enabled: boolean }
export interface HookOutcome { blocked?: string; context: string; problems: string[] }
export class HookError extends Error { constructor(message: string) { super(message); this.name = "HookError"; } }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const blocking: HookEvent[] = ["UserPromptSubmit", "PreToolUse", "PostToolUse"];
const toolEvents: HookEvent[] = ["PreToolUse", "PostToolUse"];
const outputLimit = 65536;
/**
 * With a verified Stellan-Host in the package, hooks run through Host (`stellan-host --run-hook`): the same rules,
 * replies and messages; Host stops a hook's whole process tree on a time limit or cancel. STICK_HOOKS_ON_NODE=1 keeps Node.
 */
let hostHooks: { executable: string; roots: string } | undefined;
export function useHostHooks(executable: string | undefined, roots = ""): void { hostHooks = executable && process.env.STICK_HOOKS_ON_NODE !== "1" ? { executable, roots } : undefined; }

export function hookConfig(input: unknown, id: string): HookConfig {
  if (!record(input)) { throw new HookError("Enter the hook's settings."); }
  const event = input.event as HookEvent;
  if (!hookEvents.includes(event)) { throw new HookError("Choose when the hook runs."); }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : event;
  if (name.length > 80 || /[\x00-\x1f]/.test(name)) { throw new HookError("Use a hook name under 80 characters."); }
  const matcher = typeof input.matcher === "string" ? input.matcher.trim() : "";
  if (matcher && !toolEvents.includes(event)) { throw new HookError("Only tool hooks (before or after a tool) use a tool filter. Leave it empty."); }
  if (matcher.length > 200) { throw new HookError("Keep the tool filter under 200 characters."); }
  if (matcher && matcher !== "*") { try { new RegExp(`^(?:${matcher})$`); } catch { throw new HookError("The tool filter isn't valid. Use a tool name such as edit_file, or write_file|edit_file."); } }
  const timeout = input.timeout === undefined || input.timeout === "" ? 30 : Number(input.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) { throw new HookError("Set a time limit between 1 and 600 seconds."); }
  const enabled = input.enabled !== false;
  if (input.type === "http") {
    let url: URL; try { url = new URL(String(input.url)); } catch { throw new HookError("Enter the full address of the app to notify, for example http://127.0.0.1:8765/stick."); }
    if (url.username || url.password || url.hash || url.href.length > 2048 || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) { throw new HookError("Use HTTPS, or HTTP on this computer (127.0.0.1 or localhost), without a password in the address."); }
    return { id, name, event, matcher, type: "http", url: url.href, timeout, enabled };
  }
  if (input.type !== "command") { throw new HookError("Choose whether the hook runs a command or notifies an app."); }
  if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 4096 || input.command.includes("\0")) { throw new HookError("Enter the command to run (under 4,096 characters)."); }
  return { id, name, event, matcher, type: "command", command: input.command.trim(), timeout, enabled };
}

/** Reads a hook's reply: exit code 2 or {"decision":"block","reason":…} blocks; other text becomes notes for Stellan. */
export function readReply(status: number | null, stdout: string, stderr: string): { blocked?: string; context: string; problem?: string } {
  if (status === 2) { return { blocked: stderr.trim() || stdout.trim() || "A hook blocked this.", context: "" }; }
  if (status !== 0) { return { context: "", problem: `exited with code ${status ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}` }; }
  const text = stdout.trim();
  if (text.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(text);
      if (record(value)) {
        const context = typeof value.additionalContext === "string" ? value.additionalContext : "";
        if (value.decision === "block") { return { blocked: typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : "A hook blocked this.", context }; }
        return { context };
      }
    } catch {}
  }
  return { context: text };
}

export class Hooks {
  private configs: HookConfig[] = [];
  readonly session = randomUUID();
  constructor(private root: string, private project: string, private log: (error: unknown) => void = () => {}) {}
  setProject(project: string): void { this.project = project; }
  async load(): Promise<void> {
    const saved = await readExtensionJson(this.root, "hooks.json"); if (saved === undefined) { return; }
    if (!record(saved) || saved.format !== 1 || !Array.isArray(saved.hooks) || saved.hooks.length > 50) { throw new HookError("The saved hook settings are invalid."); }
    this.configs = saved.hooks.map((hook) => { if (!record(hook) || typeof hook.id !== "string" || !/^hook-[a-f0-9-]{36}$/.test(hook.id)) { throw new HookError("The saved hook settings are invalid."); } return hookConfig(hook, hook.id); });
  }
  private async save(): Promise<void> { await writeExtensionJson(this.root, "hooks.json", { format: 1, hooks: this.configs }); }
  view(): HookConfig[] { return this.configs.map((hook) => ({ ...hook })); }
  get active(): boolean { return this.configs.some((hook) => hook.enabled); }
  async add(input: unknown): Promise<HookConfig> {
    if (this.configs.length >= 50) { throw new HookError("Remove a hook before adding another (50 at most)."); }
    const hook = hookConfig(input, `hook-${randomUUID()}`); this.configs.push(hook); await this.save(); return hook;
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const hook = this.configs.find((item) => item.id === id); if (!hook) { throw new HookError("That hook no longer exists."); }
    hook.enabled = enabled; await this.save();
  }
  async remove(id: string): Promise<void> {
    const before = this.configs.length; this.configs = this.configs.filter((item) => item.id !== id);
    if (this.configs.length === before) { throw new HookError("That hook no longer exists."); }
    await this.save();
  }
  private matches(hook: HookConfig, event: HookEvent, tool?: string): boolean {
    if (!hook.enabled || hook.event !== event) { return false; }
    if (!toolEvents.includes(event) || !hook.matcher || hook.matcher === "*") { return true; }
    return new RegExp(`^(?:${hook.matcher})$`).test(tool ?? "");
  }
  /** Runs every enabled hook for this event in order; the first block stops the rest. */
  async run(event: HookEvent, details: Record<string, unknown>, signal: AbortSignal, only?: HookConfig): Promise<HookOutcome & { ran: string[] }> {
    const hooks = only ? [only] : this.configs.filter((hook) => this.matches(hook, event, typeof details.tool_name === "string" ? details.tool_name : undefined));
    const outcome: HookOutcome & { ran: string[] } = { context: "", problems: [], ran: [] };
    const input = JSON.stringify({ hook_event_name: event, session_id: this.session, cwd: this.project, ...details });
    for (const hook of hooks) {
      if (signal.aborted) { break; }
      outcome.ran.push(hook.name);
      let reply: ReturnType<typeof readReply>;
      try { reply = hostHooks ? await this.viaHost(hostHooks, hook, event, input, signal) : hook.type === "http" ? await this.post(hook, input, signal) : await this.command(hook, event, input, signal); }
      catch (error) { if (signal.aborted) { break; } this.log(error); reply = { context: "", problem: error instanceof Error ? error.message : String(error) }; }
      if (reply.problem) { outcome.problems.push(`Hook “${hook.name}” ${reply.problem}`); }
      if (reply.context.trim()) { outcome.context += (outcome.context ? "\n" : "") + reply.context.trim().slice(0, 8000); }
      if (reply.blocked && blocking.includes(event)) { outcome.blocked = `${reply.blocked.slice(0, 2000)} (hook “${hook.name}”)`; break; }
    }
    return outcome;
  }
  private viaHost(host: { executable: string; roots: string }, hook: HookConfig, event: HookEvent, input: string, signal: AbortSignal): Promise<ReturnType<typeof readReply>> {
    return new Promise((resolve, reject) => {
      const child = spawn(host.executable, ["--run-hook", host.roots], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      let output = "";
      // Closing Host's input cancels the hook; Host then stops its whole process tree and replies.
      const cancel = (): void => { child.stdin.end(); };
      signal.addEventListener("abort", cancel, { once: true });
      child.stdout.setEncoding("utf8").on("data", (text: string) => { output += text; });
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify({ hook, event, input, project: this.project, online: this.online }) + "\n");
      if (signal.aborted) { cancel(); }
      child.once("error", (error) => { signal.removeEventListener("abort", cancel); reject(new HookError(`couldn't start: ${error.message}`)); });
      child.once("close", () => {
        signal.removeEventListener("abort", cancel);
        try {
          const reply = JSON.parse(output) as { blocked?: string; context: string; problem?: string };
          resolve({ ...(reply.blocked !== undefined ? { blocked: reply.blocked } : {}), context: reply.context, ...(reply.problem !== undefined ? { problem: reply.problem } : {}) });
        } catch { reject(new HookError("couldn't start: no reply from Stellan-Host")); }
      });
    });
  }
  /** "Allow internet" off: HTTP hooks to other computers are skipped; ones on this computer still run. */
  online = true;
  private async post(hook: HookConfig, input: string, signal: AbortSignal): Promise<ReturnType<typeof readReply>> {
    if (!this.online && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(hook.url!).hostname)) { return { context: "", problem: "was skipped because Allow internet is off" }; }
    const response = await appFetch(hook.url!, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: input, signal: AbortSignal.any([signal, AbortSignal.timeout(hook.timeout * 1000)]) });
    const text = (await response.text()).slice(0, outputLimit);
    if (!response.ok) { return { context: "", problem: `got HTTP ${response.status} from ${new URL(hook.url!).host}` }; }
    return readReply(0, text, "");
  }
  private command(hook: HookConfig, event: HookEvent, input: string, signal: AbortSignal): Promise<ReturnType<typeof readReply>> {
    const windows = process.platform === "win32";
    const shell = windows ? process.env.ComSpec ?? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : "/bin/sh";
    return new Promise((resolve, reject) => {
      const child = spawn(shell, shellArguments(shell, hook.command!, process.platform), {
        cwd: this.project, env: { ...process.env, STICK_PROJECT_DIR: this.project, STICK_HOOK_EVENT: event },
        stdio: ["pipe", "pipe", "pipe"], detached: !windows, windowsHide: true, windowsVerbatimArguments: windows && win32.basename(shell).toLowerCase() === "cmd.exe"
      });
      let stdout = "", stderr = "", failure: Error | undefined;
      const stop = (error: Error): void => { failure ??= error; if (child.pid && child.exitCode === null) { killProcessTree(child.pid, process.platform).catch(() => child.kill("SIGKILL")); } };
      const timer = setTimeout(() => stop(new HookError(`took longer than ${hook.timeout} seconds and was stopped`)), hook.timeout * 1000);
      const cancel = (): void => stop(new HookError("was cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); if (stdout.length > outputLimit) { stdout = stdout.slice(0, outputLimit); stop(new HookError("wrote more than 64 KiB and was stopped")); } });
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(0, outputLimit); });
      child.stdin.on("error", () => {}); child.stdin.end(input);
      child.once("error", (error) => { failure ??= error; });
      child.once("close", (code) => {
        clearTimeout(timer); signal.removeEventListener("abort", cancel);
        if (failure) { if (failure instanceof HookError) { resolve({ context: "", problem: failure.message }); } else { reject(new HookError(`couldn't start: ${failure.message}`)); } return; }
        resolve(readReply(code, stdout, stderr));
      });
    });
  }
}
