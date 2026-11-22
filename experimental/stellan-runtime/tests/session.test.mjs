import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openNativeSession } from '../session.mjs';
import { runNative } from '../run.mjs';

const executable = process.env.STELLAN_TEST_ENGINE;
const python = process.env.STELLAN_PYTHON;
const directory = fileURLToPath(new URL('.', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture(architecture = 'mamba2') {
  const root = await mkdtemp(join(tmpdir(), 'stellan-session-'));
  const model = join(root, 'model é.gguf');
  execFileSync(python, ['-c', 'import sys,pathlib;sys.path.insert(0,sys.argv[1]);target=sys.argv[2];architecture=sys.argv[3];sys.argv=["fixture","unused"];from models import Fixture;pathlib.Path(target).write_bytes(Fixture(architecture).bytes())', directory, model, architecture]);
  return { root, model, executable, executableSha256: hash(await readFile(executable)), sha256: hash(await readFile(model)), threads: 2, context: 128 };
}
const enabled = Boolean(executable && python);

test('persistent bridge matches fresh requests and reuses prefixes for both architectures', { skip: !enabled }, async () => {
  for (const architecture of ['mamba2', 'llama']) {
    const options = await fixture(architecture);
    let session;
    try {
      session = await openNativeSession(options);
      await session.generate('A', { maxTokens: 1 });
      const reused = await session.generate('A B', { maxTokens: 3 });
      const fresh = [];
      await runNative({ ...options, prompt: 'A B', maxTokens: 3, onEvent: e => { if (e.event === 'token') { fresh.push(e.id); } } });
      assert.deepEqual(reused.tokens, fresh);
      assert.ok(reused.metrics.reused_tokens > 0);
      const reset = await session.generate('Z', { maxTokens: 2 });
      assert.equal(reset.metrics.reused_tokens, 0);
      const freshReset = [];
      await runNative({ ...options, prompt: 'Z', maxTokens: 2, onEvent: e => { if (e.event === 'token') { freshReset.push(e.id); } } });
      assert.deepEqual(reset.tokens, freshReset);
    } finally { await session?.close(); await rm(options.root, { recursive: true, force: true }); }
  }
});

test('concurrent and oversized requests are rejected without corrupting the session', { skip: !enabled }, async () => {
  const options = await fixture(); let session;
  try {
    session = await openNativeSession(options);
    const first = session.generate('A', { maxTokens: 2 });
    await assert.rejects(session.generate('B'), /already running/);
    await first;
    await assert.rejects(session.generate('C'.repeat(300)), /context/);
    assert.equal((await session.generate('D', { maxTokens: 1 })).tokens.length, 1);
  } finally { await session?.close(); await rm(options.root, { recursive: true, force: true }); }
});

test('cancellation retires the process and prevents reuse of partial state', { skip: !enabled }, async () => {
  const options = await fixture(); let session;
  try {
    session = await openNativeSession(options);
    const cancel = new AbortController();
    await assert.rejects(session.generate('A', { maxTokens: 5, signal: cancel.signal, onEvent: event => { if (event.event === 'token') { cancel.abort(); } } }), /cancelled/);
    await assert.rejects(session.generate('B'), /closed/);
  } finally { await session?.close(); await rm(options.root, { recursive: true, force: true }); }
});

test('idle sessions release their owned process and tampered models are refused', { skip: !enabled }, async () => {
  const options = await fixture(); let session;
  try {
    session = await openNativeSession({ ...options, idleMs: 30 });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(session.active, false);
    await session.close();
    session = await openNativeSession(options);
    await appendFile(options.model, 'tampered');
    await assert.rejects(session.generate('A', { maxTokens: 1 }), /response|changed/);
    await session.close(); session = undefined;
    await assert.rejects(openNativeSession(options), /hash mismatch/);
  } finally { await session?.close(); await rm(options.root, { recursive: true, force: true }); }
});


test('Lite session accepts the app context setting without allocating a token-sized state', { skip: !enabled }, async () => {
  const options = await fixture(); let small, large;
  try {
    small = await openNativeSession(options);
    const stateBytes = small.startup.state_bytes;
    const expected = await small.generate('A B C', { maxTokens: 2 });
    await small.close(); small = undefined;
    large = await openNativeSession({ ...options, context: 262144 });
    assert.equal(large.startup.state_bytes, stateBytes);
    assert.deepEqual((await large.generate('A B C', { maxTokens: 2 })).tokens, expected.tokens);
  } finally { await small?.close(); await large?.close(); await rm(options.root, { recursive: true, force: true }); }
});
