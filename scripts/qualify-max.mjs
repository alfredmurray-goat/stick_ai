import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir, totalmem, freemem } from "node:os";
import { join } from "node:path";
import { successfulDesktopBuild } from "./release-build.mjs";
import { fetchMaxForRelease } from "./assemble-full-release.mjs";
import { bundledMax } from "../src/portable/max-release.ts";
import { ManagedEngine } from "../dist/portable/engine.js";
import { verifyStick } from "../dist/portable/integrity.js";
import { reservePort } from "../dist/portable/ports.js";
import { Ollama } from "../dist/model/ollama.js";
import { ramStatus } from "../dist/config/models.js";
import { coderSystem } from "../dist/agent/delegate.js";
const exec = promisify(execFile), repo = process.env.GITHUB_REPOSITORY, runId = process.env.BUILD_RUN;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^\d+$/.test(runId ?? "")) { throw new Error("Missing trusted build identity"); }
async function gh(...args) { return (await exec("gh", args, { maxBuffer: 4000000 })).stdout; }
const run = await successfulDesktopBuild(repo, runId, gh);
const temporary = await mkdtemp(join(tmpdir(), "stick-max-qualification-"));
await mkdir("release-assets", { recursive: true });
let engine, fd, heartbeat;
try {
  const archiveFolder = join(temporary, "base"); await mkdir(archiveFolder);
  await gh("run", "download", runId, "--repo", repo, "--name", "stick_ai-base-linux-x64", "--dir", archiveFolder);
  const archives = await readdir(archiveFolder);
  if (archives.length !== 1 || !archives[0].endsWith(".tar.gz")) { throw new Error("Unexpected Linux artifact"); }
  await exec("tar", ["-xzf", join(archiveFolder, archives[0]), "-C", temporary]);
  await rm(archiveFolder, { recursive: true, force: true });
  const root = join(temporary, "Stick AI"); await verifyStick(root, true);
  const max = await fetchMaxForRelease(join(temporary, "max"));
  await rename(max, join(root, bundledMax.path)); await verifyStick(root);
  const reservation = await reservePort(); await reservation.release();
  fd = openSync("release-assets/max-smoke.log", "a", 0o600);
  engine = new ManagedEngine(root, "linux-x64", reservation.port, temporary, fd, console.error);
  // This qualifies real model/runtime compatibility, not an end user's memory budget.
  engine.contextSize = 512;
  const signal = AbortSignal.timeout(30 * 60 * 1000), started = Date.now();
  heartbeat = setInterval(() => console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), totalBytes: totalmem(), freeBytes: freemem(), active: engine.active })), 30000);
  await engine.start("stellan-1-max", signal);
  const client = new Ollama("stellan-1-max", engine.baseUrl, false, ramStatus(undefined, true), { apiKey: engine.key, specialist: true, maxTokens: 64 });
  const reply = await client.complete([{ role: "system", content: coderSystem }, { role: "user", content: "Task:\nReturn exactly one line of Python code that prints the integer 42. No explanation.\n\nRelevant source context:\nNone." }], signal, () => {});
  await writeFile("release-assets/max-smoke.json", JSON.stringify({ source: run.head_sha, run: runId, modelSha256: bundledMax.sha256, contextTokens: 512, response: reply.content, toolCalls: reply.calls }, null, 2));
  if (reply.calls.length || !/\bprint\s*\(\s*42\s*\)/.test(reply.content)) { throw new Error("Max did not return the requested code; inspect the qualification artifact"); }
  console.log("REAL MAX PASSED: pinned GGUF integrity, authenticated server readiness, embedded chat template, streaming and code-only completion. Generated code was not executed.");
} finally {
  clearInterval(heartbeat);
  try { if (engine) { engine.disposing = true; await engine.stop(); } }
  finally { if (fd !== undefined) { closeSync(fd); } await rm(temporary, { recursive: true, force: true }); }
}
