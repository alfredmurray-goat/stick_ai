import { expect, it, vi } from "vitest";
import { createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lockedNames, lockModel, splitDigest, unlockModel } from "../src/portable/model-lock.js";
import { Activation, unwrapModelKey } from "../src/portable/activation.js";

// A small but real GGUF v3: a few key/values (including an array) and tensors of different sizes.
const text = (value: string): Buffer => { const b = Buffer.from(value); const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([n, b]); };
const u32 = (value: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = (value: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
function gguf(tensors: { name: string; bytes: Buffer }[]): Buffer {
  const kv = [
    Buffer.concat([text("general.architecture"), u32(8), text("llama")]),
    Buffer.concat([text("general.alignment"), u32(4), u32(32)]),
    Buffer.concat([text("tokenizer.ggml.tokens"), u32(9), u32(8), u64(3), text("a"), text("b"), text("c")])
  ];
  let offset = 0; const infos: Buffer[] = []; const data: Buffer[] = [];
  for (const tensor of tensors) {
    infos.push(Buffer.concat([text(tensor.name), u32(1), u64(tensor.bytes.length), u32(0), u64(offset)]));
    const padded = Buffer.concat([tensor.bytes, Buffer.alloc((32 - tensor.bytes.length % 32) % 32)]); data.push(padded); offset += padded.length;
  }
  const head = Buffer.concat([Buffer.from("GGUF"), u32(3), u64(tensors.length), u64(kv.length), ...kv, ...infos]);
  return Buffer.concat([head, Buffer.alloc((32 - head.length % 32) % 32), ...data]);
}
// Reads back a split: its key names and each tensor's bytes.
function readSplit(file: Buffer): { keys: string[]; tensors: Map<string, Buffer> } {
  let at = 8; const n = (): number => { const v = Number(file.readBigUInt64LE(at)); at += 8; return v; };
  const str = (): string => { const len = n(); const v = file.toString("utf8", at, at + len); at += len; return v; };
  const tensorCount = n(); const kvCount = n(); const keys: string[] = []; let alignment = 32;
  const skip = (type: number): void => { if (type === 8) { str(); return; } if (type === 9) { const inner = file.readUInt32LE(at); at += 4; const count = n(); for (let i = 0; i < count; i++) { skip(inner); } return; } at += { 2: 2, 4: 4, 5: 4 }[type] ?? 0; };
  for (let i = 0; i < kvCount; i++) { const key = str(); const type = file.readUInt32LE(at); at += 4; keys.push(key); if (key === "general.alignment") { alignment = file.readUInt32LE(at); } skip(type); }
  const infos: { name: string; size: number; offset: number }[] = [];
  for (let i = 0; i < tensorCount; i++) { const name = str(); const dims = file.readUInt32LE(at); at += 4; let size = 0; for (let d = 0; d < dims; d++) { size = n(); } at += 4; infos.push({ name, size, offset: n() }); }
  const start = Math.ceil(at / alignment) * alignment;
  return { keys, tensors: new Map(infos.map((t) => [t.name, file.subarray(start + t.offset, start + t.offset + t.size)])) };
}

it("splits a model into an encrypted first part and a plain rest that together hold every tensor", async () => {
  const folder = await mkdtemp(join(tmpdir(), "stick-lock-"));
  try {
    const tensors = [{ name: "token_embd.weight", bytes: randomBytes(1000) }, { name: "blk.0.attn_q.weight", bytes: randomBytes(77) }, { name: "blk.0.ffn.weight", bytes: randomBytes(320) }, { name: "output.weight", bytes: randomBytes(64) }];
    await writeFile(join(folder, "model.gguf"), gguf(tensors));
    const key = randomBytes(32); const base = join(folder, "stick", "model");
    const result = await lockModel(join(folder, "model.gguf"), base, key, "stellan-1-lite");
    expect(await splitDigest(join(folder, "model.gguf"))).toEqual({ firstSha256: result.firstSha256, firstSize: result.firstSize, restSha256: result.restSha256, restSize: result.restSize, tensorsInFirst: result.tensorsInFirst });
    const locked = await readFile(result.locked);
    expect(locked.toString("ascii", 0, 4)).toBe("SLCK"); expect(locked.includes(tensors[0]!.bytes.subarray(0, 32))).toBe(false);
    const first = readSplit(await readFile(await unlockModel(result.locked, join(folder, "tmp"), lockedNames("model").first, key, "stellan-1-lite")));
    const rest = readSplit(await readFile(result.rest));
    expect(first.keys).toEqual(expect.arrayContaining(["general.architecture", "tokenizer.ggml.tokens", "split.no", "split.count", "split.tensors.count"]));
    expect(rest.keys).toEqual(["general.alignment", "split.no", "split.count", "split.tensors.count"]);
    for (const tensor of tensors) { expect(Buffer.compare((first.tensors.get(tensor.name) ?? rest.tensors.get(tensor.name))!, tensor.bytes)).toBe(0); }
    expect(first.tensors.size + rest.tensors.size).toBe(4); expect(rest.tensors.size).toBeGreaterThan(0);
    await expect(unlockModel(result.locked, join(folder, "tmp2"), "x-00001-of-00002.gguf", randomBytes(32), "stellan-1-lite")).rejects.toThrow(/couldn't be unlocked/);
    await expect(unlockModel(result.locked, join(folder, "tmp3"), "x-00001-of-00002.gguf", key, "stellan-1-max")).rejects.toThrow(/couldn't be unlocked/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("keeps model keys from the activation reply, and they only open on the stick they were sealed for", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-keys-"));
  try {
    const pair = generateKeyPairSync("ed25519"); const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const stick = "a".repeat(64); const code = "ABCDEFGHJKMN"; const lite = randomBytes(32);
    const wrap = (key: Buffer, forStick: string): string => { const k = Buffer.from(hkdfSync("sha256", Buffer.from(forStick, "hex"), "stick-ai-model-keys", code, 32)); const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", k, iv); return Buffer.concat([iv, c.update(key), c.final(), c.getAuthTag()]).toString("base64"); };
    const server = (async (_url: string | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); const payload = Buffer.from(JSON.stringify({ v: 1, code: body.code, stick: body.stick })).toString("base64url"); return new Response(JSON.stringify({ certificate: `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString("base64url")}`, keys: { "stellan-1-lite": wrap(lite, body.stick) } }), { status: 200 }); }) as unknown as typeof fetch;
    const first = new Activation(root, publicKey, "https://example.test", async () => stick, server);
    await first.activate("ABCD-EFGH-JKMN");
    expect(first.modelKey("stellan-1-lite")?.equals(lite)).toBe(true); expect(first.modelKey("stellan-1-max")).toBeUndefined();
    const offline = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const restart = new Activation(root, publicKey, "https://example.test", async () => stick, offline);
    expect(await restart.check()).toBe(true); expect(restart.modelKey("stellan-1-lite")?.equals(lite)).toBe(true);
    expect(unwrapModelKey(wrap(lite, stick), "b".repeat(64), code)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("finds a locked model on the stick and refuses to start it without the activation's key", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-locked-root-"));
  try {
    const { lockedModels, lockedRecords } = await import("../src/portable/locked-models.js");
    const { resolveLocalModel } = await import("../src/portable/local-models.js");
    const { ManagedEngine } = await import("../src/portable/engine.js");
    await mkdir(join(root, "models"), { recursive: true }); await mkdir(join(root, "logs")); await mkdir(join(root, "tmp"));
    const records = lockedRecords(lockedModels["stellan-1-lite"]);
    for (const record of records) { await writeFile(join(root, record.path), "x"); }
    await writeFile(join(root, "manifest.json"), JSON.stringify({ files: records }));
    const found = await resolveLocalModel(root, "lite");
    expect(found?.locked?.model.label).toBe("stellan-1-lite"); expect(found?.path).toMatch(/-00002-of-00002\.gguf$/);
    const engine = new ManagedEngine(root, "linux-x64", 8080, join(root, "tmp"), -1, vi.fn());
    await expect(engine.start("stellan-1-lite", new AbortController().signal)).rejects.toThrow(/Activate this stick/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
