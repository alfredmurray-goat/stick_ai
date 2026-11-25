import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { hashFile } from "./integrity.js";
import { nativeHostExecutable } from "./native-files.js";

export interface FrontDoor { url: string; close(): void }
/**
 * Stage 1 of moving the app server into Stellan-Host: Host answers the window on its own 127.0.0.1 port, serves the
 * window's files itself and forwards API requests to this Node backend (which still checks the session key) until
 * each route has a native implementation. Returns undefined when the package has no Host, so callers keep using the
 * Node address.
 */
export async function openFrontDoor(root: string, backendUrl: string, log: (error: unknown) => void = () => {}): Promise<FrontDoor | undefined> {
  const host = nativeHostExecutable(root);
  if (!host) { return undefined; }
  if ((await hashFile(host.executable)).sha256 !== host.sha256) { throw new Error("Stellan-Host does not match this package. Reinstall the app from the stick."); }
  const backend = new URL(backendUrl);
  const child: ChildProcess = spawn(host.executable, ["--front-door", join(root, "app", "ui"), backend.port], { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
  child.stderr?.on("data", (chunk: Buffer) => log(new Error(`Stellan-Host front door: ${chunk.toString("utf8").slice(0, 500)}`)));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("Stellan-Host's front door did not start")); child.kill(); }, 10000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Stellan-Host's front door stopped")); });
    createInterface({ input: child.stdout! }).once("line", (line) => {
      clearTimeout(timer);
      try { const ready = JSON.parse(line) as { event?: unknown; port?: unknown }; if (ready.event === "ready" && typeof ready.port === "number" && ready.port > 1023 && ready.port < 65536) { resolve(ready.port); } else { reject(new Error("Unexpected front door greeting")); } }
      catch (error) { reject(error); }
    });
  });
  return { url: `http://127.0.0.1:${port}/${backend.hash}`, close: () => { child.stdin?.end(); } };
}
