import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { totalmem, platform, arch } from "node:os";
import { readTokenizer } from "./tokenizer.mjs";

async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) { digest.update(chunk); }
  return digest.digest("hex");
}

async function collect(executable, args, ids) {
  const start = performance.now();
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let diagnostic = "";
  let failure;
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; if (output.length > 8 * 1024 * 1024) { failure = new Error("Benchmark output exceeds limits"); child.kill(); } });
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-16384); });
  child.stdin.on("error", error => { failure ??= error; });
  child.stdin.end(ids.join(",") + "\n");
  try {
    await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", code => { if (failure) { reject(failure); } else if (code !== 0) { reject(new Error(diagnostic || "Benchmark process failed")); } else { accept(); } });
    });
  } finally { process.off("SIGINT", stop); }
  const events = output.trim().split("\n").map(line => JSON.parse(line));
  const metrics = events.at(-1);
  if (metrics?.event !== "finished" || !Number.isFinite(metrics.prompt_ms) || !Number.isFinite(metrics.decode_ms)) { throw new Error("Benchmark process returned incomplete metrics"); }
  return { metrics, wallMsIncludingStartup: performance.now() - start, generatedIds: events.filter(event => event.event === "token").map(event => event.id) };
}

async function main() {
  const [native, reference, model, sha256, prompt, tokenText = "32", repeatText = "5", threadText = "2", repack] = process.argv.slice(2);
  if (![native, reference, model, sha256, prompt].every(value => typeof value === "string") || !/^[a-f0-9]{64}$/.test(sha256) || repack !== undefined && repack !== "no-repack") { throw new Error("Usage: compare.mjs NATIVE REFERENCE MODEL SHA256 PROMPT [TOKENS] [REPEATS] [THREADS] [no-repack]"); }
  const tokens = Number(tokenText);
  const repeats = Number(repeatText);
  const threads = Number(threadText);
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 4096 || !Number.isInteger(repeats) || repeats < 1 || repeats > 20 || !Number.isInteger(threads) || threads < 1 || threads > 64) { throw new Error("Invalid benchmark limits"); }
  if (await hash(model) !== sha256) { throw new Error("Model integrity check failed"); }
  const tokenizer = await readTokenizer(model);
  if (tokenizer.mode === "gpt2" && totalmem() < 16 * 1024 ** 3) { throw new Error("Max benchmarks require at least 16 GB RAM; use a larger machine"); }
  const ids = tokenizer.encode(prompt);
  if (ids.length + tokens > 8192) { throw new Error("Benchmark exceeds the matched 8192-token context"); }
  const report = {
    format: 1,
    purpose: "CPU diagnostic only; not release qualification",
    baselineIsShippingConfiguration: false,
    physicalHardwareValidated: false,
    hardware: { platform: platform(), arch: arch(), ramBytes: totalmem(), threads },
    modelSha256: sha256,
    nativeSha256: await hash(native),
    referenceSha256: await hash(reference),
    promptTokensSha256: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
    tokenLimit: tokens,
    context: 8192,
    activationMode: process.env.STELLAN_RUNTIME_PRECISE ? "f32" : "q8",
    runs: []
  };
  for (let repeat = 0; repeat < repeats; repeat++) {
    const pair = { repeat };
    const commands = [
      ["candidate", native, ["decode", model, sha256, "-", String(tokens), String(threads), "8192"]],
      ["baseline", reference, [model, String(tokens), String(threads), "8192", ...(repack ? [repack] : [])]]
    ];
    if (repeat % 2 === 1) { commands.reverse(); }
    for (const [name, executable, args] of commands) { pair[name] = await collect(executable, args, ids); }
    for (const name of ["candidate", "baseline"]) { pair[name].text = Buffer.concat(pair[name].generatedIds.map(id => tokenizer.decodeBytes(id))).toString("utf8"); }
    pair.identicalGeneratedIds = JSON.stringify(pair.candidate.generatedIds) === JSON.stringify(pair.baseline.generatedIds);
    report.runs.push(pair);
    process.stderr.write(`Completed paired CPU probe ${repeat + 1}/${repeats}\n`);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
