import { spawn } from "node:child_process";
import { openSync, appendFileSync, closeSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Sandbox } from "../sandbox/paths.js";
import { verifyStick } from "./integrity.js";
import { ManagedEngine } from "./engine.js";
import { reservePort } from "./ports.js";
import { localModelStatus } from "./local-models.js";
import { nodeRelease, portableModels, targetFor, userMessage, UserError } from "./platform.js";
import { createInterface } from "node:readline";
import { friendlyError } from "./errors.js";
import { desktopDryRun, launchDesktop } from "./desktop.js";
import { webApp } from "./web.js";

export function dryRunActions(root: string, platform: string = process.platform, arch: string = process.arch, bytes = totalmem(), noSwap = false): string[] {
  const target = targetFor(platform, arch); const models = bytes < 8 * 1024 ** 3 ? [] : portableModels(bytes, true);
  return [
    bytes < 8 * 1024 ** 3 ? "Memory check would stop launch: this computer needs at least 8 GB; the following actions are a preview only." : "Memory check permits Lite startup.",
    `Verify the manifest and all static files under ${root}; allow only the absent optional Max file.`,
    `Select ${target}; verify the bundled Node runtime, app, binaries, sidecars and model hashes.`,
    `Use Lite by default; Max ${models.length === 2 ? "is available" : "is hidden and locked"}; swapping ${noSwap ? "is disabled" : "uses one model process at a time"}.`,
    "Create one private system temporary folder and put caches and temporary files there.",
    "Choose an unused model port between 8080 and 8099; never reuse an existing listener.",
    "Open the authenticated browser start screen on a free 127.0.0.1 port.",
    "After Start chatting, launch Lite on 127.0.0.1 with context 8192 and a random authentication key.",
    "Poll health and authenticated model identity until ready or cancelled; refuse an unexpected server.",
    "For delegate_code, stop Lite, load Max on the same port, request code, stop Max and reload Lite; wait until ready or cancelled, with no delegation call limit.",
    "Use Stop to end the session; log technical details only on the stick.",
    "On exit, cancel work, stop the owned model process, close the UI and delete the private temporary folder."
  ];
}
async function openBrowser(url: string): Promise<void> {
  const file = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe") : "xdg-open";
  const args = process.platform === "win32" ? [`${join(process.env.SystemRoot ?? "C:\\Windows", "System32", "url.dll")},FileProtocolHandler`, url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore", windowsHide: true, detached: true });
    const timer = setTimeout(resolve, 1500); child.unref();
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); if (code === 0) { resolve(); } else { reject(new UserError("browser")); } });
  });
}
async function service(root: string, noSwap: boolean, desktopLog?: string, faster = false, initialModel: "stellan-1-lite" | "stellan-1-max" = "stellan-1-lite"): Promise<void> {
  if (desktopLog) { await mkdir(desktopLog, { recursive: true }); }
  const logPath = desktopLog ? join(desktopLog, "launcher.log") : await (await Sandbox.create(root)).path("logs/launcher.log", true);
  const desktop = Boolean(desktopLog);
  const notify = (event: unknown): void => { if (desktop) { process.stdout.write(JSON.stringify(event) + "\n"); } };
  const fd = openSync(logPath, "a", 0o600);
  const log = (error: unknown): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`); } catch {} };
  let temp: string | undefined; let engine: ManagedEngine | undefined;
  let app: Awaited<ReturnType<typeof webApp>> | undefined; let stopping = false;
  const lifetime = new AbortController();
  const report = (text: string): void => { if (process.connected) { process.send?.({ text }); } notify({ kind: "progress", text }); };
  const stop = async (): Promise<void> => {
    if (stopping) { return; } stopping = true; lifetime.abort();
    if (engine) { engine.disposing = true; }
    for (const cleanup of [() => app?.close(), () => engine?.stop(), () => temp ? rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) : undefined]) {
      try { await cleanup(); } catch (error) { log(error); report("The assistant could not close completely; restart your computer before unplugging the stick."); process.exitCode = 1; }
    }
    closeSync(fd); notify({ kind: "stopped" }); controls?.close(); process.stdin.destroy(); if (process.connected) { process.disconnect?.(); }
  };
  const controls = desktop ? createInterface({ input: process.stdin }) : undefined;
  controls?.on("line", (line) => { if (line === "stop") { void stop(); } });
  controls?.on("close", () => { void stop(); });
  process.on("disconnect", () => { void stop(); });
  process.on("message", (value) => { if (value === "stop") { void stop(); } });
  process.on("SIGINT", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
  process.on("uncaughtException", (error) => { log(error); report(userMessage(error)); void stop(); });
  process.on("unhandledRejection", (error) => { log(error); report(userMessage(error)); void stop(); });
  try {
    if (process.versions.node !== nodeRelease) { throw new UserError("damaged"); }
    report("Starting your private assistant...");
    targetFor(process.platform, process.arch); portableModels(totalmem(), true);
    const prepare = async (): Promise<void> => {
      const maxPresent = (await localModelStatus(root)).available;
      const choices = portableModels(totalmem(), maxPresent);
      temp = await mkdtemp(join(tmpdir(), "stick-ai-"));
      const port = await reservePort(); await port.release();
      engine = new ManagedEngine(root, targetFor(process.platform, process.arch), port.port, temp, fd, log);
      engine.contextSize = faster ? 4096 : 8192;
      engine.onProcess = (pid) => notify({ kind: "model_pid", pid });
      app = await webApp({ root, engine, bytes: totalmem(), choices, noSwap, desktop, faster, report, log, stop });
    };
    if (desktop) {
      await launchDesktop({
        verify: async () => { await verifyStick(root, true, lifetime.signal); },
        prepare,
        startLite: async () => { await app!.start(initialModel); },
        waitHealthy: async () => { if (engine?.active !== initialModel) { throw new UserError("loading"); } },
        openChat: async () => { notify({ kind: "ready", url: app!.url }); },
        stop: async () => { await engine?.stop(); },
        cleanup: async () => {}
      }, lifetime.signal);
    } else {
      await verifyStick(root, true, lifetime.signal); await prepare();
      await openBrowser(app!.url).catch(() => { throw new UserError("browser"); });
    }
    report("Running privately on this computer. Close this window to stop.");
  } catch (error) { if (stopping) { return; } log(error); notify({ kind: "error", error: friendlyError(error) }); report(userMessage(error)); process.exitCode = 1; await stop(); }
}
export async function launcherMain(args = process.argv.slice(2)): Promise<void> {
  const index = args.indexOf("--root");
  const root = await realpath(resolve(index >= 0 ? args[index + 1] ?? "." : dirname(process.argv[1] ?? ".")));
  const noSwap = args.includes("--no-swap");
  if (args.includes("--desktop") && args.includes("--dry-run")) { for (const action of desktopDryRun(root)) { console.log(action); } return; }
  if (args.includes("--desktop")) { const at = args.indexOf("--log-dir"); if (at < 0 || !args[at + 1]) { throw new UserError("storage"); } const modeAt = args.indexOf("--model"); const selected = modeAt < 0 ? "stellan-1-lite" : args[modeAt + 1]; if (selected !== "stellan-1-lite" && selected !== "stellan-1-max") { throw new UserError("unsupported"); } await service(root, noSwap, resolve(args[at + 1]!), args.includes("--faster"), selected); return; }
  if (args.includes("--dry-run")) { for (const action of dryRunActions(root, process.platform, process.arch, totalmem(), noSwap)) { console.log(action); } return; }
  if (args.includes("--service")) { await service(root, noSwap); return; }
  const box = await Sandbox.create(root); await mkdir(await box.path("logs", true), { recursive: true });
  const logPath = await box.path("logs/launcher.log", true); const fd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [process.argv[1]!, "--root", root, "--service", ...(noSwap ? ["--no-swap"] : [])], { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd, "ipc"], env: { ...(process.env.STICK_CONTEXT_MAX_BYTES ? { STICK_CONTEXT_MAX_BYTES: process.env.STICK_CONTEXT_MAX_BYTES } : {}), TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir(), PATH: process.env.PATH ?? process.env.Path ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}) } });
  let status = "Starting your private assistant..."; let tick = 0;
  const show = (): void => { process.stdout.write(`\r${status}${status.startsWith("Starting") ? " "+["◐", "◓", "◑", "◒"][tick++ % 4] : ""}   `); };
  const timer = setInterval(show, 350); show();
  child.on("message", (message: unknown) => { if (message && typeof message === "object" && "text" in message && typeof message.text === "string") { status = message.text; show(); } });
  const stop = (): void => { if (child.connected) { child.send("stop"); } };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) { process.on(signal, stop); }
  try {
    await new Promise<void>((resolve, reject) => { child.once("error", (error) => { appendFileSync(logPath, String(error) + "\n"); reject(error); }); child.once("exit", (code) => { process.exitCode = code ?? 1; resolve(); }); });
  } finally { clearInterval(timer); closeSync(fd); process.stdout.write("\n"); }
}
if (process.argv[1] && /(?:launcher\.cjs|entry\.js)$/.test(process.argv[1])) {
  launcherMain().catch(() => { console.log(userMessage(new UserError("general"))); process.exitCode = 1; });
}
