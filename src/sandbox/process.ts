import { spawn } from "node:child_process";
import { win32 } from "node:path";

export interface ProcessSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  verbatim?: boolean;
}
export async function killProcessTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") { throw error; }
    }
    return;
  }
  const system = process.env.SystemRoot ?? "C:\\Windows";
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(win32.join(system, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", env: { SystemRoot: system } });
    const timer = setTimeout(() => { killer.kill(); reject(new Error("taskkill timed out; verify no descendants remain")); }, 5000);
    killer.once("error", (error) => { clearTimeout(timer); reject(error); });
    killer.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 128) { resolve(); } else { reject(new Error(`taskkill failed (${code}); verify no descendants remain`)); }
    });
  });
}
export async function runProcess(spec: ProcessSpec, signal: AbortSignal, timeout?: number): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"],
      detached: spec.platform !== "win32", windowsHide: true,
      windowsVerbatimArguments: spec.verbatim ?? false
    });
    let output = "";
    let failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    let settled = false;
    let emergency: NodeJS.Timeout | undefined;
    const finish = (code: number | null): void => {
      if (settled) { return; }
      settled = true; clearTimeout(timer); clearTimeout(emergency); signal.removeEventListener("abort", cancel);
      if (failure) { reject(failure); } else { resolve(`exit=${code}\n${output}`); }
    };
    const stop = (error?: Error): Promise<void> => {
      if (error && !failure) { failure = error; }
      if (!stopping) {
        stopping = child.pid ? killProcessTree(child.pid, spec.platform).catch((killError: unknown) => { child.kill("SIGKILL"); failure = new Error(`${failure?.message ?? "Process cleanup failed"}: ${String(killError)}`); }) : Promise.resolve();
        emergency = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 7000);
      }
      return stopping;
    };
    const cancel = (): void => { void stop(new Error("Shell cancelled")); };
    const timer = timeout === undefined ? undefined : setTimeout(() => { void stop(new Error(`Shell exceeded ${timeout / 1000} seconds`)); }, timeout);
    const collect = (data: Buffer): void => {
      output += data.toString("utf8");
      if (output.length > 65536) { output = output.slice(0, 65536); void stop(new Error("Shell output exceeds 64 KiB")); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); }
    child.once("error", (error) => { failure = error; finish(null); });
    child.once("exit", () => { if (spec.platform !== "win32") { void stop(); } });
    child.once("close", (code) => { void (stopping ?? Promise.resolve()).then(() => finish(code)); });
  });
}
