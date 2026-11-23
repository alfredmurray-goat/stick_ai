import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { totalmem } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readTokenizer } from "./tokenizer.mjs";
import { filePrompt, inputTypes } from "./inputs.mjs";

export { launchPlan } from "./plan.mjs";
import { launchPlan } from "./plan.mjs";

export async function runNative({ executable, executableSha256, model, sha256, prompt, maxTokens = 128, threads = 2, context = 8192, forceMax = false, kvCache = "f16", signal, onEvent = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? "")) { throw new Error("A trusted model SHA256 is required"); }
  if (!/^[a-f0-9]{64}$/.test(executableSha256 ?? "")) { throw new Error("A trusted executable SHA256 is required"); }
  if (signal?.aborted) { throw new Error("Generation cancelled"); }
  const executableHash = createHash("sha256");
  for await (const bytes of createReadStream(executable)) {
    if (signal?.aborted) { throw new Error("Generation cancelled"); }
    executableHash.update(bytes);
  }
  if (executableHash.digest("hex") !== executableSha256) { throw new Error("The executable hash does not match; refusing to start"); }
  const tokenizer = await readTokenizer(model);
  const tokens = tokenizer.encode(prompt);
  const plan = launchPlan({ mode: tokenizer.mode, tokens, maxTokens, threads, context, forceMax, kvCache });
  if (plan.warning) { onEvent({ event: "warning", text: plan.warning }); }
  onEvent({ event: "status", text: "Checking and starting the local model..." });
  const nativeEnv = { ...process.env };
  if (kvCache === "q8_0") nativeEnv.STELLAN_RUNTIME_KV_Q8 = "1"; else delete nativeEnv.STELLAN_RUNTIME_KV_Q8;
  const child = spawn(resolve(executable), ["decode", resolve(model), sha256, "-", String(maxTokens), String(threads), String(context), ...(forceMax ? ["--force-max"] : [])], {
    env: nativeEnv, stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false
  });
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let diagnostic = "";
  let finished = false;
  let failure;
  let killTimer;
  let stopping = false;
  const started = performance.now();
  let lastOutput = started;
  let phase = "Checking and starting the local model...";
  const abort = () => {
    if (stopping) { return; }
    stopping = true;
    child.kill("SIGINT");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    killTimer.unref();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) { abort(); }
  const progress = setInterval(() => {
    try {
      const elapsed = performance.now() - started;
      onEvent({ event: "status", text: performance.now() - lastOutput >= 60000 ? "Still working. Large models on this computer can take a few minutes." : phase, ...(elapsed >= 10000 ? { elapsedSeconds: Math.floor(elapsed / 1000) } : {}) });
    } catch (error) { failure = error; abort(); }
  }, 1000);
  progress.unref();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", value => { diagnostic = (diagnostic + value).slice(-8192); });
  child.stdin.on("error", error => { failure ??= error; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", value => {
    try {
      buffer += value;
      if (buffer.length > 1048576) { throw new Error("Native event exceeds limits"); }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) { continue; }
        const event = JSON.parse(line);
        if (!["prompt_progress", "token", "finished"].includes(event.event)) { throw new Error("Unknown native event"); }
        lastOutput = performance.now();
        if (event.event === "prompt_progress") { phase = "Reading your request..."; }
        if (event.event === "token") { event.text = decoder.decode(tokenizer.decodeBytes(event.id), { stream: true }); phase = "Writing the answer..."; }
        if (event.event === "finished") {
          if (event.model_sha256 !== sha256) { throw new Error("Native model identity changed"); }
          finished = true;
          const tail = decoder.decode();
          if (tail) { onEvent({ event: "text", text: tail }); }
        }
        onEvent(event);
      }
    } catch (error) { failure = error; abort(); }
  });
  child.stdin.end(tokens.join(",") + "\n");
  try {
    await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (signal?.aborted) { reject(new Error("Generation cancelled")); }
        else if (failure) { reject(failure); }
        else if (code !== 0 || !finished || buffer.trim()) { reject(new Error(diagnostic.trim() || "The local engine stopped before finishing")); }
        else { accept(); }
      });
    });
  } finally {
    clearInterval(progress);
    signal?.removeEventListener("abort", abort);
    if (killTimer) { clearTimeout(killTimer); }
  }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--capabilities") { process.stdout.write(JSON.stringify(await inputTypes(), null, 2) + "\n"); return; }
  const options = {};
  const files = [];
  const flags = new Map([["--engine", "executable"], ["--engine-sha256", "executableSha256"], ["--model", "model"], ["--sha256", "sha256"], ["--prompt", "prompt"], ["--tokens", "maxTokens"], ["--threads", "threads"], ["--context", "context"], ["--kv-cache", "kvCache"]]);
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === "--file") { if (i + 1 >= process.argv.length || files.length >= 4) { throw new Error("Supply up to four --file paths"); } files.push(process.argv[++i]); continue; }
    if (flag === "--force-max") { options.forceMax = true; continue; }
    const key = flags.get(flag);
    if (!key || i + 1 >= process.argv.length || key in options) { throw new Error("Check the experimental launcher arguments"); }
    options[key] = ["maxTokens", "threads", "context"].includes(key) ? Number(process.argv[++i]) : process.argv[++i];
  }
  if (!["executable", "executableSha256", "model", "sha256", "prompt"].every(key => typeof options[key] === "string")) { throw new Error("Supply the engine, model, trusted hashes and prompt"); }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try { options.prompt = await filePrompt(options.prompt, files, controller.signal); await runNative({ ...options, signal: controller.signal, onEvent: event => process.stdout.write(JSON.stringify(event) + "\n") }); }
  finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
}
