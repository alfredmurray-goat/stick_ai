// HumanEval (all 164 problems), pass@1 with greedy decoding, each answer executed against the official tests.
// Uses the same llama.cpp settings as the app. Resumes from the results file if it already exists.
//   node scripts/benchmark-humaneval.mjs --server <llama-server> --gguf <file> --model stellan-1-max \
//        --problems <HumanEval.jsonl> --out <results.json> [--sample 8] [--gpu-layers 999]
import { spawn, execFile } from "node:child_process";
import { request } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, totalmem, cpus } from "node:os";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { modelRuntimeArgs } from "../dist/portable/engine.js";

const exec = promisify(execFile);
const { values } = parseArgs({ options: { server: { type: "string" }, gguf: { type: "string" }, model: { type: "string" }, problems: { type: "string" }, out: { type: "string" }, sample: { type: "string" }, port: { type: "string", default: "18100" }, "gpu-layers": { type: "string", default: "0" } } });
for (const key of ["server", "gguf", "model", "problems", "out"]) { if (!values[key]) { throw new Error(`Missing --${key}`); } }
const model = values.model;
if (!["stellan-1-lite", "stellan-1-max"].includes(model)) { throw new Error("--model must be stellan-1-lite or stellan-1-max"); }
const every = Number(values.sample ?? 1);
const problems = readFileSync(values.problems, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((_, index) => index % every === 0);
const done = existsSync(values.out) ? JSON.parse(readFileSync(values.out, "utf8")) : { model, results: [] };
// A request that failed (server busy, connection dropped) says nothing about the model: try those again.
done.results = done.results.filter((result) => !String(result.error ?? "").startsWith("request failed"));
// Node's fetch gives up on a response that takes more than 300 s to start, which a slow CPU easily exceeds
// for longer answers (a Kaggle run lost 119 of 149 problems to it). Plain http has no such limit.
function postJson(url, value, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => { try { resolve(JSON.parse(text)); } catch { reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`)); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("no answer within the time limit")));
    req.on("error", reject); req.end(JSON.stringify(value));
  });
}
const port = values.port;
// The app's own settings: Lite 8192 context with the Mistral-v1 formatter, Max 4096 context with its embedded template.
const lite = model === "stellan-1-lite";
const args = ["--model", values.gguf, "--alias", model, "--ctx-size", lite ? "8192" : "4096", "--host", "127.0.0.1", "--port", port, "--no-webui", "--no-warmup", "--gpu-layers", values["gpu-layers"], ...modelRuntimeArgs(model), ...(lite ? ["--no-jinja", "--skip-chat-parsing", "--chat-template", "mistral-v1"] : [])];
const started = Date.now();
const server = spawn(values.server, args, { stdio: ["ignore", "ignore", "pipe"] });
let serverLog = ""; server.stderr.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-4000); });
for (;;) {
  try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { break; } } catch { /* still loading */ }
  if (server.exitCode !== null) { console.log(serverLog); process.exit(1); }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
Object.assign(done, { loadSeconds: (Date.now() - started) / 1000, totalMemGB: +(totalmem() / 1024 ** 3).toFixed(1), cpus: cpus().length, cpu: cpus()[0]?.model ?? "", gpuLayers: Number(values["gpu-layers"]) });
const save = () => writeFileSync(values.out, JSON.stringify(done, null, 2));
try {
  for (const problem of problems) {
    if (done.results.some((result) => result.task === problem.task_id)) { continue; }
    const messages = [{ role: "system", content: "You are an expert Python programmer." }, { role: "user", content: "Complete the following Python function. Return the complete function, including its signature and any imports it needs, in a single ```python code block with no explanation.\n\n```python\n" + problem.prompt + "```" }];
    const start = Date.now(); let body;
    try {
      body = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, { model, messages, temperature: 0, max_tokens: 768, cache_prompt: true, stream: false }, 3 * 3600 * 1000);
    } catch (error) { done.results.push({ task: problem.task_id, passed: false, error: "request failed: " + error.message }); save(); continue; }
    const text = body.choices?.[0]?.message?.content ?? ""; const seconds = (Date.now() - start) / 1000;
    const block = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/); let code = block ? block[1] : text;
    if (!new RegExp(`def\\s+${problem.entry_point}\\s*\\(`).test(code)) { code = problem.prompt + code; }
    const imports = problem.prompt.split("\n").filter((line) => /^(from\s+\S+\s+import|import)\s/.test(line)).join("\n");
    const folder = mkdtempSync(join(tmpdir(), "humaneval-")); const file = join(folder, "check.py");
    writeFileSync(file, `${imports}\n${code}\n\n${problem.test}\ncheck(${problem.entry_point})\n`);
    let passed = false, error = "";
    try { await exec("timeout", ["15", "python3", "-I", file], { cwd: folder }); passed = true; } catch (failure) { error = String(failure.stderr || failure.message).split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? "failed"; }
    rmSync(folder, { recursive: true, force: true });
    done.results.push({ task: problem.task_id, passed, seconds, promptTokens: body.timings?.prompt_n, genTokens: body.timings?.predicted_n, genTokPerSec: body.timings?.predicted_per_second, ...(passed ? {} : { error }) });
    save();
    console.log(`${model} ${problem.task_id}: ${passed ? "PASS" : "fail"} in ${seconds.toFixed(0)}s (${done.results.filter((result) => result.passed).length}/${done.results.length})`);
  }
} finally { server.kill("SIGKILL"); }
const passed = done.results.filter((result) => result.passed).length;
done.passRate = passed / done.results.length; save();
console.log(`${model} DONE: ${passed}/${done.results.length} passed (${(100 * done.passRate).toFixed(1)}%)`);
