import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Lite's and Max's local model server run by Stellan-Host (`stellan-host --serve-model`) instead of inside the app's Node
 * process: same routes, checks and replies as portable/stellan-server.mjs, with Host's own tokenizer and session.
 */
export async function startHostModelServer(options: {
  host: string; model: string; sha256: string; modelName: string; key: string; port: number; context: number; threads: number;
  environment: NodeJS.ProcessEnv; temp: string; splitModel?: string; splitSha256?: string; signal: AbortSignal; onProcess: (process: ChildProcess) => void;
}): Promise<{ close(): Promise<void> }> {
  const keyFile = join(options.temp, "host-model-key");
  await writeFile(keyFile, options.key, { mode: 0o600 });
  const child = spawn(options.host, ["--serve-model", options.host, options.model, options.sha256, String(options.threads), String(options.context), String(options.port), keyFile, options.modelName,
    ...(options.splitModel && options.splitSha256 ? ["--split", options.splitModel, options.splitSha256] : [])], { env: options.environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr = (stderr + text).slice(-4000); });
  const abort = () => child.kill();
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", (line) => { if (line === '{"event":"ready"}') resolve(); });
      child.once("error", reject);
      void exited.then(() => reject(new Error(stderr.trim().replace(/^stellan-host: /, "") || "The model could not start. Restart the app.")));
    });
  } finally { options.signal.removeEventListener("abort", abort); }
  options.signal.throwIfAborted();
  options.onProcess(child);
  return {
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref();
      await exited; clearTimeout(timer);
    }
  };
}
