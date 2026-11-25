import {extensionSmoke} from "./extension-smoke.mjs";
import { randomUUID } from "node:crypto";
import { runAgent } from "../dist/agent/index.js";
import { Sandbox } from "../dist/sandbox/paths.js";
import { Tools } from "../dist/tools/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { openSync, closeSync, writeSync } from "node:fs";
import { tmpdir, totalmem, freemem } from "node:os";
import { join, resolve } from "node:path";
import { ManagedEngine, gpuLayerArgs, isVirtualMac } from "../dist/portable/engine.js";
import { reservePort } from "../dist/portable/ports.js";
import { Ollama } from "../dist/model/ollama.js";
import { ramStatus } from "../dist/config/models.js";
import { targetFor } from "../dist/portable/platform.js";
import { openFrontDoor } from "../dist/portable/front-door.js";
import { parseStep } from "../dist/model/protocol.js";
const target = targetFor(process.platform, process.arch);
const native = target.startsWith("macos-") ? "Stick AI.app/Contents/MacOS/stick-ai" : target === "windows-x64" ? "Stick AI.exe" : "stick-ai";
const root = resolve(process.argv[2]); const temporary = await mkdtemp(join(tmpdir(), "stick-smoke-"));
await mkdir("release-assets", { recursive: true });
const fd = openSync("release-assets/smoke.log", "a", 0o600); const reservation = await reservePort(); await reservation.release();
const engine = new ManagedEngine(root, target, reservation.port, temporary, fd, console.error);
// Public Apple Silicon runners have fewer cores and less memory than private runners.
// Keep the complete real-tool check, with a CI-only deadline that allows CPU inference.
const signal = AbortSignal.timeout(45 * 60 * 1000);
const started = Date.now(); let reporting = false;
async function reportMemory() {
  if (reporting) { return; } reporting = true;
  try {
    let detail = `smoke elapsed=${Math.round((Date.now() - started) / 1000)}s total=${totalmem()} free=${freemem()} model=${engine.active ?? "loading"}`;
    if (process.platform === "darwin") {
      for (const [file, args] of [["/usr/bin/vm_stat", []], ["/bin/sh", ["-c", "ps -axm -o rss=,comm= | head -6"]], ...(engine.child?.pid ? [["/bin/ps", ["-o", "pid,rss,vsz,%cpu,stat", "-p", String(engine.child.pid)]]] : [])]) {
        try { detail += "\n" + (await promisify(execFile)(file, args, { timeout: 5000 })).stdout; } catch {}
      }
    }
    console.error(detail); writeSync(fd, "\n" + detail + "\n");
  } finally { reporting = false; }
}
await reportMemory();
const heartbeat = setInterval(() => { void reportMemory().catch(console.error); }, 30000);
try {
  await promisify(execFile)(join(root, native), ["--dry-run"]);
  if (process.platform === "darwin") {
  for (const file of [`bin/${target}/node`, `bin/${target}/stellan-run`, native]) {
    const { stdout } = await promisify(execFile)("/usr/bin/otool", ["-L", join(root, file)]);
    const dependencies = stdout.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
    if (dependencies.some((path) => !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"))) { throw new Error(`Non-portable library dependency in ${file}: ${dependencies.join(", ")}`); }
  }
  }
  if (process.platform === "linux") {
    for (const file of [`bin/${target}/node`, `bin/${target}/stellan-run`, native]) {
      const { stdout } = await promisify(execFile)("ldd", [join(root, file)]);
      if (stdout.includes("not found")) { throw new Error(`Missing Linux runtime library: ${stdout}`); }
    }
  }
  // The packaged Host must answer the window and forward API requests (stage 1 of replacing Node).
  {
    const { createServer } = await import("node:http");
    const backend = createServer((request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ forwarded: request.url, host: request.headers.host })); });
    await new Promise((done) => backend.listen(0, "127.0.0.1", done));
    const backendPort = backend.address().port;
    const front = await openFrontDoor(root, `http://127.0.0.1:${backendPort}/#${"a".repeat(64)}`);
    if (!front) throw new Error("The release package is missing Stellan-Host's front door");
    try {
      const origin = new URL(front.url).origin;
      const page = await fetch(origin + "/"); const html = await page.text();
      if (page.status !== 200 || !html.includes("Start chatting")) throw new Error("Stellan-Host did not serve the app window");
      const api = await fetch(origin + "/api/state?x=1"); const body = await api.json();
      if (body.forwarded !== "/api/state?x=1" || body.host !== `127.0.0.1:${backendPort}`) throw new Error("Stellan-Host did not forward an API request");
      console.log(`${target} Stellan-Host front door served the window and forwarded an API request.`);
    } finally { front.close(); backend.close(); }
  }
  await engine.start("stellan-1-lite", signal);
  if (!engine.nativeRuntime) throw new Error("The release must use Stellan-Run");
  const client = new Ollama("stellan-1-lite", engine.baseUrl, false, ramStatus(), { apiKey: engine.key, maxTokens: 2048 });
  // Use the app's normal output allowance; preserve partial responses even on timeout.
  const attempts = [];
  const measured = { complete: async (messages, stepSignal, emit) => {
    const attempt = { step: attempts.length + 1, elapsed_ms: 0, content: "", thinking: "" };
    attempts.push(attempt); const began = Date.now();
    try {
      const reply = await client.complete(messages, stepSignal, (text, thinking) => {
        const field = thinking ? "thinking" : "content";
        attempt[field] = (attempt[field] + text).slice(-65536); emit(text, thinking);
      });
      attempt.content = reply.content; return reply;
    } catch (error) { attempt.error = String(error); throw error; }
    finally {
      attempt.elapsed_ms = Date.now() - began;
      await writeFile("release-assets/model-smoke.json", JSON.stringify({ runtime: "Stellan-Run", attempts }, null, 2));
      console.log(`Model check step ${attempt.step}: ${attempt.elapsed_ms} ms, ${attempt.content.length} response characters${attempt.error ? ", failed" : ""}.`);
    }
  } };
  const result = await measured.complete([{ role: "system", content: 'You are Stellan-1 Lite. This is a startup check. Reply with exactly <done>Ready</done>. Do not call tools or write code.' }, { role: "user", content: "Are you ready?" }], signal, () => {});
  const parsed = parseStep(result.content);
  await writeFile("release-assets/model-smoke.json", JSON.stringify({ architecture: "mamba2", response: result.content, protocol: parsed.step.kind }, null, 2));
  if (parsed.step.kind !== "done") { throw new Error("Lite loaded, but did not follow its required tagged protocol; inspect model-smoke.json before shipping"); }
  const project = join(temporary, "project"); await mkdir(project);
  const expected = `Violet otter ${randomUUID().slice(0, 4)}`; await writeFile(join(project, "note.txt"), expected);
  const tools = new Tools(await Sandbox.create(project), async () => false);
  const messages = []; let read = false; let summary = "";
  const outcome = await runAgent({
    task: "Use read_file to read note.txt, then quote the entire file contents exactly in your done summary; use the returned content, without guessing. Do not change files or run programs.",
    messages, model: measured, maxSteps: 4, signal,
    tools: { execute: async (call, stepSignal) => {
      if (!["read_file", "list_dir", "search_files"].includes(call.function.name)) { return "Only reading tools are allowed in this startup check."; }
      if (call.function.name === "read_file") { read = true; }
      return tools.execute(call, stepSignal);
    } },
    emit: (text, thinking) => { if (!thinking) { summary += text; } }, log: console.log, save: async () => {}
  });
  await writeFile("release-assets/model-smoke.json", JSON.stringify({ architecture: "mamba2", runtime: "Stellan-Run", gpu: engine.nativeRuntime ? "CPU (Stellan-Run)" : engine.gpuFailed ? "fell back to CPU" : gpuLayerArgs(target, "stellan-1-lite", totalmem(), process.env, isVirtualMac())[1] === "0" ? (isVirtualMac() ? "CPU (virtual Mac)" : "CPU") : "Metal", response: result.content, attempts, agent: { outcome, read, summary, messages } }, null, 2));
  if (outcome !== "finished" || !read || !summary.includes(expected)) { throw new Error("Lite did not complete a real read_file/tool_result/done exchange; do not ship this package"); }
  if (target === "linux-x64") await extensionSmoke({client,temporary,project,signal});
  console.log(`${target} Lite compute: ${engine.nativeRuntime ? "Stellan-Run CPU" : engine.gpuFailed ? "Metal GPU failed to start; CPU fallback used" : gpuLayerArgs(target, "stellan-1-lite", totalmem(), process.env, isVirtualMac())[1] === "0" ? (isVirtualMac() ? "CPU (virtual Mac, paravirtual Metal skipped)" : "CPU") : "Metal GPU"}.`);
  console.log(`${target} Lite passed native execution, portable library checks, authenticated readiness, streaming and a real read_file/tool_result/done exchange.`);
} finally { clearInterval(heartbeat); engine.disposing = true; await engine.stop(); closeSync(fd); await rm(temporary, { recursive: true, force: true }); }
