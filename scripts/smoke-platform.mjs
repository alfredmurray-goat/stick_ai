import { randomUUID } from "node:crypto";
import { runAgent } from "../dist/agent/index.js";
import { Sandbox } from "../dist/sandbox/paths.js";
import { Tools } from "../dist/tools/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedEngine } from "../dist/portable/engine.js";
import { reservePort } from "../dist/portable/ports.js";
import { Ollama } from "../dist/model/ollama.js";
import { ramStatus } from "../dist/config/models.js";
import { targetFor } from "../dist/portable/platform.js";
import { parseStep } from "../dist/model/protocol.js";
const target = targetFor(process.platform, process.arch);
const native = target.startsWith("macos-") ? "Stick AI.app/Contents/MacOS/stick-ai" : target === "windows-x64" ? "Stick AI.exe" : "stick-ai";
const root = resolve(process.argv[2]); const temporary = await mkdtemp(join(tmpdir(), "stick-smoke-"));
await mkdir("release-assets", { recursive: true });
const fd = openSync("release-assets/smoke.log", "a", 0o600); const reservation = await reservePort(); await reservation.release();
const engine = new ManagedEngine(root, target, reservation.port, temporary, fd, console.error); engine.patient = true;
const signal = AbortSignal.timeout(10 * 60 * 1000);
try {
  await promisify(execFile)(join(root, native), ["--dry-run"]);
  if (process.platform === "darwin") {
  for (const file of [`bin/${target}/node`, `bin/${target}/llama-server`, native]) {
    const { stdout } = await promisify(execFile)("/usr/bin/otool", ["-L", join(root, file)]);
    const dependencies = stdout.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
    if (dependencies.some((path) => !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"))) { throw new Error(`Non-portable library dependency in ${file}: ${dependencies.join(", ")}`); }
  }
  }
  if (process.platform === "linux") {
    for (const file of [`bin/${target}/node`, `bin/${target}/llama-server`, native]) {
      const { stdout } = await promisify(execFile)("ldd", [join(root, file)]);
      if (stdout.includes("not found")) { throw new Error(`Missing Linux runtime library: ${stdout}`); }
    }
  }
  await engine.start("stellan-1-lite", signal);
  const client = new Ollama("stellan-1-lite", engine.baseUrl, false, ramStatus(), { apiKey: engine.key, maxTokens: 256 });
  const result = await client.complete([{ role: "system", content: 'You are Stellan-1 Lite. This is a startup check. Reply with exactly <done>Ready</done>. Do not call tools or write code.' }, { role: "user", content: "Are you ready?" }], signal, () => {});
  const parsed = parseStep(result.content);
  await writeFile("release-assets/model-smoke.json", JSON.stringify({ architecture: "mamba2", response: result.content, protocol: parsed.step.kind }, null, 2));
  if (parsed.step.kind !== "done") { throw new Error("Lite loaded, but did not follow its required tagged protocol; inspect model-smoke.json before shipping"); }
  const project = join(temporary, "project"); await mkdir(project);
  const expected = `Violet otter ${randomUUID().slice(0, 4)}`; await writeFile(join(project, "note.txt"), expected);
  const tools = new Tools(await Sandbox.create(project), async () => false);
  const messages = []; let read = false; let summary = "";
  const outcome = await runAgent({
    task: "Use read_file to read note.txt, then quote the entire file contents exactly in your done summary; use the returned content, without guessing. Do not change files or run programs.",
    messages, model: client, maxSteps: 4, signal,
    tools: { execute: async (call, stepSignal) => {
      if (!["read_file", "list_dir", "search_files"].includes(call.function.name)) { return "Only reading tools are allowed in this startup check."; }
      if (call.function.name === "read_file") { read = true; }
      return tools.execute(call, stepSignal);
    } },
    emit: (text, thinking) => { if (!thinking) { summary += text; } }, log: console.log, save: async () => {}
  });
  await writeFile("release-assets/model-smoke.json", JSON.stringify({ architecture: "mamba2", response: result.content, agent: { outcome, read, summary, messages } }, null, 2));
  if (outcome !== "finished" || !read || !summary.includes(expected)) { throw new Error("Lite did not complete a real read_file/tool_result/done exchange; do not ship this package"); }
  console.log(`${target} Lite passed native execution, portable library checks, authenticated readiness, streaming and a real read_file/tool_result/done exchange.`);
} finally { engine.disposing = true; await engine.stop(); closeSync(fd); await rm(temporary, { recursive: true, force: true }); }
