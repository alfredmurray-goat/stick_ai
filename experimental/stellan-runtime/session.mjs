import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { readTokenizer } from './tokenizer.mjs';
import { launchPlan } from './run.mjs';

export async function openNativeSession({ executable, executableSha256, model, sha256, threads = 2, context = 8192, forceMax = false, kvCache = "f16", signal, startupTimeoutMs = 180000, idleMs = 600000 }) {
  if (![sha256, executableSha256].every(value => /^[a-f0-9]{64}$/.test(value ?? ''))) { throw new Error('Trusted model and executable SHA256 hashes are required'); }
  if (!Number.isInteger(idleMs) || idleMs < 1 || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1) { throw new Error('Session timeouts must be positive integers'); }
  if (signal?.aborted) { throw new Error('Session startup cancelled'); }
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(executable)) {
    if (signal?.aborted) { throw new Error('Session startup cancelled'); }
    hash.update(bytes);
  }
  if (hash.digest('hex') !== executableSha256) { throw new Error('The executable hash does not match'); }
  const tokenizer = await readTokenizer(model);
  launchPlan({ mode: tokenizer.mode, tokens: [1], threads, context, maxTokens: 1, forceMax, kvCache });
  if (signal?.aborted) { throw new Error('Session startup cancelled'); }
  const nativeEnv = { ...process.env };
  if (kvCache === "q8_0") nativeEnv.STELLAN_RUNTIME_KV_Q8 = "1"; else delete nativeEnv.STELLAN_RUNTIME_KV_Q8;
  const child = spawn(resolve(executable), ['serve', resolve(model), sha256, String(threads), String(context), ...(forceMax ? ['--force-max'] : [])], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let buffer = '', diagnostic = '', pending, requestId = 0, stopped = false, ready = false, idleTimer, killTimer;
  let acceptReady, rejectReady, acceptClosed;
  const initialized = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; });
  const closed = new Promise(accept => { acceptClosed = accept; });
  function settle(error, result) {
    if (!pending) { return; }
    const current = pending; pending = undefined;
    current.signal?.removeEventListener('abort', current.abort);
    if (error) { current.reject(error); } else { current.accept(result); }
  }
  function stop(error) {
    if (stopped) { return; }
    stopped = true;
    clearTimeout(idleTimer);
    rejectReady(error);
    settle(error);
    child.stdin.end();
    child.kill('SIGINT');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killTimer.unref();
  }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(new Error('Session rested after inactivity; reopen it to continue')), idleMs);
    idleTimer.unref();
  }
  const startupAbort = () => stop(new Error('Session startup cancelled'));
  signal?.addEventListener('abort', startupAbort, { once: true });
  if (signal?.aborted) { startupAbort(); }
  const startupTimer = setTimeout(() => stop(new Error('Session startup timed out')), startupTimeoutMs);
  startupTimer.unref();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-8192); });
  child.stdin.on('error', error => stop(error));
  child.on('error', error => stop(error));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    try {
      buffer += chunk;
      if (buffer.length > 1048576) { throw new Error('Session event exceeds limit'); }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) { continue; }
        const event = JSON.parse(line);
        if (stopped) { continue; }
        if (event.event === 'ready') {
          if (ready || event.model_sha256 !== sha256) { throw new Error('Unexpected session model identity'); }
          ready = true; acceptReady(event); armIdle(); continue;
        }
        if (!ready || !pending || event.request_id !== pending.id || !['prompt_progress', 'token', 'finished', 'error'].includes(event.event)) { throw new Error('Unexpected session response'); }
        if (event.event === 'error') { throw new Error(event.message || 'Native request failed'); }
        if (event.event === 'token') {
          event.text = pending.decoder.decode(tokenizer.decodeBytes(event.id), { stream: true });
          pending.text += event.text;
          pending.tokens.push(event.id);
        }
        if (event.event === 'finished') {
          if (event.model_sha256 !== sha256 || event.generated !== pending.tokens.length) { throw new Error('Session result identity or token count changed'); }
          pending.text += pending.decoder.decode();
          pending.onEvent(event);
          settle(null, { text: pending.text, tokens: pending.tokens, metrics: event });
          armIdle();
        } else { pending.onEvent(event); }
      }
    } catch (error) { stop(error); }
  });
  child.once('close', code => {
    clearTimeout(killTimer); clearTimeout(idleTimer); clearTimeout(startupTimer);
    signal?.removeEventListener('abort', startupAbort);
    const error = new Error(diagnostic.trim() || `Session stopped (code ${code})`);
    stopped = true; rejectReady(error); settle(error); acceptClosed();
  });
  let startup;
  try { startup = await initialized; }
  catch (error) { stop(error); await closed; throw error; }
  finally { clearTimeout(startupTimer); signal?.removeEventListener('abort', startupAbort); }
  return {
    startup,
    get active() { return !stopped; },
    generate(prompt, { maxTokens = 128, signal: requestSignal, onEvent = () => {} } = {}) {
      if (stopped) { return Promise.reject(new Error('Session is closed; reopen it')); }
      if (pending) { return Promise.reject(new Error('A session request is already running')); }
      if (requestSignal?.aborted) { return Promise.reject(new Error('Generation cancelled')); }
      let tokens;
      try {
        if (typeof prompt !== 'string' || prompt.length > 1048576 || typeof onEvent !== 'function') { throw new Error('Invalid session prompt or callback'); }
        tokens = tokenizer.encode(prompt);
        launchPlan({ mode: tokenizer.mode, tokens, maxTokens, threads, context, forceMax, kvCache });
        if (tokens.length + maxTokens > context) { throw new Error('The request exceeds the session context limit'); }
        if (++requestId > 4294967295) { throw new Error('Session request limit reached; reopen it'); }
      } catch (error) { return Promise.reject(error); }
      clearTimeout(idleTimer);
      return new Promise((accept, reject) => {
        const abort = () => stop(new Error('Generation cancelled; reopen the session'));
        pending = { id: requestId, accept, reject, abort, signal: requestSignal, onEvent, decoder: new TextDecoder('utf8'), text: '', tokens: [] };
        requestSignal?.addEventListener('abort', abort, { once: true });
        if (requestSignal?.aborted) { abort(); return; }
        child.stdin.write(`${requestId} ${maxTokens} ${tokens.join(',')}\n`, error => { if (error) { stop(error); } });
      });
    },
    async close() { stop(new Error('Session closed')); await closed; }
  };
}
