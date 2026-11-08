import { openSync, appendFileSync, closeSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedEngine } from "./engine.js";
import { reservePort } from "./ports.js";
import { verifyStick } from "./integrity.js";
import { modelFile, targetFor } from "./platform.js";
import { Sandbox } from "../sandbox/paths.js";

export async function managedSession(path: string) {
  const root = await realpath(path); await verifyStick(root, true);
  const box = await Sandbox.create(root); await mkdir(await box.path("logs", true), { recursive: true });
  const logPath = await box.path("logs/launcher.log", true);
  const log = (error: unknown): void => appendFileSync(logPath, `${new Date().toISOString()} ${String(error)}\n`);
  const fd = openSync(logPath, "a", 0o600); const temp = await mkdtemp(join(tmpdir(), "stick-ai-cli-"));
  let port;
  try { port = await reservePort(); await port.release(); } catch (error) { await rm(temp, { recursive: true, force: true }); closeSync(fd); throw error; }
  const engine = new ManagedEngine(root, targetFor(process.platform, process.arch), port.port, temp, fd, log);
  let maxPresent = true; try { await access(join(root, modelFile("stellan-1-max"))); } catch { maxPresent = false; }
  return { engine, maxPresent, async close() { engine.disposing = true; try { await engine.stop(); } finally { try { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } finally { closeSync(fd); } } } };
}
