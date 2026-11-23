import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { tmpdir, totalmem, platform, arch, cpus } from 'node:os';
import { readTokenizer } from './tokenizer.mjs';
import { openNativeSession } from './session.mjs';

const [candidate, reference, modelPath, sha256, outputPath, count = '5', previous] = process.argv.slice(2);
if (![candidate, reference, modelPath, outputPath].every(v => typeof v === 'string' && v.length) || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw Error('Usage: node bench-paired.mjs CANDIDATE LLAMA_SERVER MODEL SHA256 NEW_REPORT.json [REPEATS] [PREVIOUS_NATIVE]');
const repetitions = Number(count);
if (!Number.isInteger(repetitions) || repetitions < 3 || repetitions > 20) throw Error('Use 3..20 repetitions');
if (['STELLAN_RUNTIME_PRECISE', 'STELLAN_RUNTIME_SCALAR', 'STELLAN_RUNTIME_KV_Q8'].some(k => process.env[k] !== undefined)) throw Error('Clear runtime arithmetic/cache overrides before benchmarking');
const model = resolve(modelPath), output = resolve(outputPath);
const arms = [{ name: 'llama.cpp', path: resolve(reference), reference: true }, ...(previous ? [{ name: 'previous-stellan', path: resolve(previous) }] : []), { name: 'candidate-stellan', path: resolve(candidate) }];
if ([model, ...arms.map(a => a.path)].includes(output)) throw Error('Output must be a separate new report');
for (const arm of arms) arm.sha256 = createHash('sha256').update(readFileSync(arm.path)).digest('hex');
const control = new AbortController();
const abort = () => control.abort(new Error('Benchmark cancelled'));
process.once('SIGINT', abort); process.once('SIGTERM', abort);
async function digest(path) { const hash = createHash('sha256'); for await (const b of createReadStream(path)) { control.signal.throwIfAborted(); hash.update(b); } return hash.digest('hex'); }
if (await digest(model) !== sha256) throw Error('Model hash mismatch');
const tokenizer = await readTokenizer(model), max = tokenizer.mode === 'gpt2';
if (max && totalmem() < 24 * 1024 ** 3) throw Error('Full Max diagnostic requires at least 24 GiB reported RAM');
const prompts = ['<s>[INST] Write a Python function add(a, b) that returns their sum. Return only code. [/INST]', '<s>[INST] Write a Python function square(n) that returns n times n. Return only code. [/INST]'];
const report = { format: 1, date: new Date().toISOString(), complete: false, purpose: 'Rotating-order CPU diagnostic, not production replacement qualification', baselineIsShippingConfiguration: false, physicalHardwareValidated: false, hardware: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, ramBytes: totalmem() }, modelSha256: sha256, expectedReferenceCommit: 'cd959bae99ff4bed22bef2604f45241c09bbb8c8', referenceCommitVerified: false, threads: 2, context: 8192, maxTokens: 12, cache: max ? 'q8_0' : 'recurrent', repetitions, arms, prompts, runs: [], limitations: ['Two short public synthetic prompts; greedy twelve-token output is not an agent quality test', 'Engines run sequentially with rotating order; shared host and warm OS page cache can affect timings', 'CPU only, 8192 context, no speculative decoding; differs from the complete shipped app configuration', 'Reference startup excludes app verification; native startup includes full integrity checks', 'Max is not tested unless its full weights fit the explicit RAM gate; physical devices/GPU/agent tasks still required'] };
const fd = openSync(output, 'wx', 0o600); closeSync(fd);
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
save();
let ticks;
if (platform() === 'linux') { try { ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()); } catch {} }
function processUsage(pid) {
 if (platform() !== 'linux') return null;
 try {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const hwm = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return { cpuMs: ticks > 0 ? (Number(fields[11]) + Number(fields[12])) * 1000 / ticks : null, peakRssBytes: hwm ? Number(hwm[1]) * 1024 : null };
 } catch { return null; }
}
async function referenceRound(arm, repeat) {
 const reservation = createServer();
 await new Promise((yes, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', yes); });
 const port = reservation.address().port;
 await new Promise((yes, no) => reservation.close(e => e ? no(e) : yes()));
 const directory = await mkdtemp(join(tmpdir(), 'stellan-paired-'));
 const key = randomBytes(32).toString('hex'), keyFile = join(directory, 'key');
 await writeFile(keyFile, key, { mode: 0o600 });
 const log = openSync(join(directory, 'reference.log'), 'w', 0o600);
 const args = ['--model', model, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', '8192', '--threads', '2', '--threads-batch', '2', '--gpu-layers', '0', '--no-repack', '--api-key-file', keyFile, '--parallel', '1', '--batch-size', max ? '128' : '512', '--ubatch-size', max ? '64' : '256', '--cache-ram', '0', ...(max ? ['--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'] : ['--ctx-checkpoints', '1', '--no-jinja', '--skip-chat-parsing', '--chat-template', 'mistral-v1']), '--no-webui', '--no-warmup'];
 report.referenceArgs = args.map(a => a === model ? '<pinned-model.gguf>' : a === keyFile ? '<private-key-file>' : a);
 const began = performance.now(), child = spawn(arm.path, args, { stdio: ['ignore', log, log], shell: false });
 let startupError;
 const closed = new Promise(yes => { child.once('close', yes); child.once('error', e => { startupError = e; }); });
 const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
 control.signal.addEventListener('abort', stop, { once: true });
 try {
  for (;;) {
   control.signal.throwIfAborted();
   if (startupError) throw startupError;
   if (child.exitCode !== null || child.signalCode !== null) throw Error('Reference exited: ' + readFileSync(join(directory, 'reference.log'), 'utf8').slice(-2000));
   try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([control.signal, AbortSignal.timeout(1000)]) })).ok) break; } catch {}
   if (performance.now() - began > 180000) throw Error('Reference startup timed out');
   await new Promise(r => setTimeout(r, 100));
  }
  const startupMs = performance.now() - began;
  for (let prompt = 0; prompt < prompts.length; prompt++) {
   const before = processUsage(child.pid), started = performance.now();
   const response = await fetch(`http://127.0.0.1:${port}/completion`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ prompt: tokenizer.encode(prompts[prompt]), n_predict: 12, temperature: 0, seed: 0, cache_prompt: false, return_tokens: true }), signal: AbortSignal.any([control.signal, AbortSignal.timeout(1800000)]) });
   const result = await response.json(), after = processUsage(child.pid);
   if (!response.ok || result.error || !Array.isArray(result.tokens) || !result.tokens.every(Number.isInteger) || !Number.isFinite(result.timings?.prompt_ms) || !Number.isFinite(result.timings?.predicted_ms)) throw Error('Reference returned incomplete output');
   report.runs.push({ arm: arm.name, repeat, prompt, startupMs, tokens: result.tokens, text: result.content, timings: result.timings, wallMs: performance.now() - started, cpuMs: before?.cpuMs != null && after?.cpuMs != null ? after.cpuMs - before.cpuMs : null, peakRssBytes: after?.peakRssBytes ?? null }); save();
  }
 } finally {
  stop(); const kill = setTimeout(() => child.kill('SIGKILL'), 2000); kill.unref();
  await closed; clearTimeout(kill); control.signal.removeEventListener('abort', stop); closeSync(log); await rm(directory, { recursive: true, force: true });
 }
}
async function nativeRound(arm, repeat) {
 const began = performance.now();
 const session = await openNativeSession({ executable: arm.path, executableSha256: arm.sha256, model, sha256, threads: 2, context: 8192, kvCache: max ? 'q8_0' : 'f16', signal: control.signal });
 const startupMs = performance.now() - began;
 try {
  for (let prompt = 0; prompt < prompts.length; prompt++) {
   const started = performance.now(), result = await session.generate(prompts[prompt], { maxTokens: 12, signal: control.signal });
   report.runs.push({ arm: arm.name, repeat, prompt, startupMs, startup: session.startup, tokens: result.tokens, text: result.text, timings: result.metrics, wallMs: performance.now() - started, cpuMs: result.metrics.cpu_ms, peakRssBytes: result.metrics.peak_rss_bytes }); save();
  }
 } finally { await session.close(); }
}
try {
 for (let repeat = 0; repeat < repetitions; repeat++) for (let offset = 0; offset < arms.length; offset++) {
  const arm = arms[(repeat + offset) % arms.length];
  await (arm.reference ? referenceRound : nativeRound)(arm, repeat);
  process.stderr.write(`${repeat + 1}/${repetitions}: ${arm.name} complete\n`);
 }
 report.identicalGeneratedIds = prompts.every((_, prompt) => {
  const rows = report.runs.filter(r => r.prompt === prompt);
  return rows.every(r => JSON.stringify(r.tokens) === JSON.stringify(rows[0].tokens));
 });
 report.complete = true; save();
} catch (error) { report.error = error.message; save(); throw error; }
finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
process.stdout.write(JSON.stringify({ report: output, identicalGeneratedIds: report.identicalGeneratedIds }) + '\n');
