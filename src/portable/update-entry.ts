import { createInterface } from "node:readline";
import { appendFile, realpath } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { checkForUpdate, prepareUpdate, applyPreparedUpdate, readUpdateConfig } from "./update.js";

function argument(name: string): string {
  const at = process.argv.indexOf(name); const value = at < 0 ? undefined : process.argv[at + 1];
  if (!value || value.startsWith("--")) { throw new Error("Missing update argument"); } return value;
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { return false; } throw error; } }
async function relaunch(root: string, temporary: string, failed = false): Promise<void> {
  const config = await readUpdateConfig(root); const args = ["--cleanup-update", temporary, ...(failed ? ["--update-failed"] : [])];
  const command = config.target.startsWith("macos-") ? "/usr/bin/open" : join(root, config.target === "windows-x64" ? "Stick AI.exe" : "stick-ai");
  const child = spawn(command, config.target.startsWith("macos-") ? ["-n", "-a", join(root, "Stick AI.app"), "--args", ...args] : args, { cwd: root, detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
}
export async function updaterMain(): Promise<void> {
  const root = resolve(argument("--root"));
  if (process.argv.includes("--apply")) {
    const work = resolve(argument("--work")); const temporary = resolve(argument("--temporary")); const parent = Number(argument("--parent"));
    if (!Number.isSafeInteger(parent) || parent <= 0 || await realpath(dirname(process.execPath)) !== await realpath(temporary)) { throw new Error("Invalid updater parent"); }
    while (alive(parent)) { await setTimeout(100); }
    let failed = false;
    try { await applyPreparedUpdate(root, work); }
    catch { failed = true; await appendFile(join(work, "update.log"), "Update could not be applied. The previous version was restored where possible.\n"); }
    await relaunch(root, temporary, failed); return;
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let token = "";
  for await (const line of input) {
    if (line.length > 20000) { throw new Error("Invalid update credentials"); }
    const value = JSON.parse(line) as { token?: unknown }; if (typeof value.token === "string") { token = value.token; }
    break;
  }
  input.close();
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify(await checkForUpdate(root, token, AbortSignal.timeout(15000)))); return;
  }
  if (process.argv.includes("--prepare")) {
    const controller = new AbortController();
    const parent = Number(argument("--parent"));
    if (!Number.isSafeInteger(parent) || parent <= 0) { throw new Error("Invalid updater parent"); }
    const monitor = globalThis.setInterval(() => { if (!alive(parent)) { controller.abort(); } }, 1000);
    process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
    try {
      const work = await prepareUpdate(root, token, controller.signal);
      controller.signal.throwIfAborted();
      console.log(JSON.stringify({ state: "prepared", work })); return;
    } finally { globalThis.clearInterval(monitor); }
  }
  throw new Error("Unknown update action");
}
if (process.argv[1] && /(?:stick-update\.cjs|update-entry\.js)$/.test(process.argv[1])) {
  updaterMain().catch(() => { console.log(JSON.stringify({ state: "error", message: "The app update could not finish. Your current copy is still available." })); process.exitCode = 1; });
}
