// Locked models. A sold stick carries each model as two GGUF splits: a small first split (all the
// metadata, the vocabulary and the first tensors) encrypted with AES-256-GCM, and the large rest in the
// clear. Without the first split the rest is useless to any GGUF tool. The key comes from the website
// once, at activation (activation.ts), so files copied off a stick can't be run elsewhere.
//
// At start the first split is decrypted into the computer's temporary folder (never the stick) and
// llama.cpp reads the other split straight from the stick: our build is patched to look for later
// splits in LLAMA_SPLIT_DIR (scripts/llama-split-dir.patch). Like activation, this stops casual
// copying, not a determined expert with an activated stick: the app is open source.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { once } from "node:events";

export const lockMagic = "SLCK";
const lockVersion = 1;
/** The first split holds tensors until it reaches this size, so it can't be rebuilt from public files. */
export const firstSplitBytes = 64 * 1024 * 1024;
const maxLockedTensor = 32 * 1024 * 1024;

/** File names on the stick for a model whose plain file would be `<base>.gguf`. */
export function lockedNames(base: string): { locked: string; rest: string; first: string } {
  return { locked: `${base}.locked`, rest: `${base}-00002-of-00002.gguf`, first: `${base}-00001-of-00002.gguf` };
}

// ---------- Reading and writing GGUF headers ----------
const scalarSize: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
interface Tensor { info: Buffer; name: string; offset: bigint; size: bigint }
interface Header { version: number; kv: Buffer; kvCount: bigint; tensors: Tensor[]; alignment: number; alignmentKv: Buffer | undefined; dataStart: number }

class Reader {
  position = 0;
  constructor(private file: Awaited<ReturnType<typeof open>>, private size: number) {}
  async bytes(length: number): Promise<Buffer> {
    if (length < 0 || this.position + length > this.size || length > 64 * 1024 * 1024) { throw new Error("This GGUF file is damaged."); }
    const buffer = Buffer.alloc(length); const { bytesRead } = await this.file.read(buffer, 0, length, this.position);
    if (bytesRead !== length) { throw new Error("This GGUF file is damaged."); }
    this.position += length; return buffer;
  }
  async u32(): Promise<number> { return (await this.bytes(4)).readUInt32LE(0); }
  async u64(): Promise<bigint> { return (await this.bytes(8)).readBigUInt64LE(0); }
  async text(): Promise<string> { return (await this.bytes(Number(await this.u64()))).toString("utf8"); }
  async skipValue(type: number): Promise<void> {
    if (type === 8) { await this.bytes(Number(await this.u64())); return; }
    if (type === 9) {
      const inner = await this.u32(); const count = await this.u64();
      if (inner in scalarSize) { this.position += Number(count) * scalarSize[inner]!; if (this.position > this.size) { throw new Error("This GGUF file is damaged."); } return; }
      for (let i = 0n; i < count; i++) { await this.skipValue(inner); }
      return;
    }
    if (!(type in scalarSize)) { throw new Error("This GGUF file uses a value type this app doesn't know."); }
    this.position += scalarSize[type]!;
  }
}

async function readHeader(path: string): Promise<Header> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size; const r = new Reader(file, size);
    if ((await r.bytes(4)).toString("ascii") !== "GGUF") { throw new Error("This is not a GGUF model file."); }
    const version = await r.u32(); if (version !== 3) { throw new Error("Only GGUF version 3 models can be locked."); }
    const tensorCount = await r.u64(); const kvCount = await r.u64();
    const kvStart = r.position; let alignment = 32; let alignmentKv: Buffer | undefined;
    for (let i = 0n; i < kvCount; i++) {
      const start = r.position; const key = await r.text(); const type = await r.u32();
      if (key.startsWith("split.")) { throw new Error("This model is already split."); }
      if (key === "general.alignment" && type === 4) { alignment = await r.u32(); alignmentKv = await readSlice(file, start, r.position); continue; }
      await r.skipValue(type);
    }
    const kv = await readSlice(file, kvStart, r.position);
    const tensors: Tensor[] = [];
    for (let i = 0n; i < tensorCount; i++) {
      const start = r.position; const name = await r.text(); const dims = await r.u32(); r.position += dims * 8 + 4; const offset = await r.u64();
      tensors.push({ info: await readSlice(file, start, r.position - 8), name, offset, size: 0n });
    }
    const dataStart = Math.ceil(r.position / alignment) * alignment;
    // Each tensor's bytes run up to the next tensor (or the end of the file), padding included.
    const byOffset = [...tensors].sort((a, b) => a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0);
    byOffset.forEach((tensor, index) => { tensor.size = (byOffset[index + 1]?.offset ?? BigInt(size - dataStart)) - tensor.offset; });
    return { version, kv, kvCount, tensors, alignment, alignmentKv, dataStart };
  } finally { await file.close(); }
}
async function readSlice(file: Awaited<ReturnType<typeof open>>, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - start); await file.read(buffer, 0, buffer.length, start); return buffer;
}
const ggufString = (value: string): Buffer => { const text = Buffer.from(value, "utf8"); const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(text.length)); return Buffer.concat([length, text]); };
const kvU16 = (key: string, value: number): Buffer => { const v = Buffer.alloc(6); v.writeUInt32LE(2, 0); v.writeUInt16LE(value, 4); return Buffer.concat([ggufString(key), v]); };
const kvI32 = (key: string, value: number): Buffer => { const v = Buffer.alloc(8); v.writeUInt32LE(5, 0); v.writeInt32LE(value, 4); return Buffer.concat([ggufString(key), v]); };

/** The header of one split: its key/values and the tensors it holds, with offsets inside this split. */
function splitHeader(header: Header, index: number, count: number, tensors: Tensor[], kv: Buffer, kvCount: bigint): Buffer {
  const fixed = Buffer.alloc(24); fixed.write("GGUF", 0, "ascii"); fixed.writeUInt32LE(header.version, 4);
  fixed.writeBigUInt64LE(BigInt(tensors.length), 8); fixed.writeBigUInt64LE(kvCount + 3n, 16);
  const split = Buffer.concat([kvU16("split.no", index), kvU16("split.count", count), kvI32("split.tensors.count", header.tensors.length)]);
  let offset = 0n; const infos: Buffer[] = [];
  for (const tensor of tensors) { const o = Buffer.alloc(8); o.writeBigUInt64LE(offset); infos.push(tensor.info, o); offset += tensor.size; }
  const head = Buffer.concat([fixed, kv, split, ...infos]);
  return Buffer.concat([head, Buffer.alloc((header.alignment - head.length % header.alignment) % header.alignment)]);
}

// ---------- Locking (owner, when preparing sticks) ----------
export interface SplitDigest { firstSha256: string; firstSize: number; restSha256: string; restSize: number; tensorsInFirst: number }
export interface LockResult extends SplitDigest { locked: string; rest: string }

/** The same split every time: tensors in file order until the first split reaches firstSplitBytes. */
async function planSplit(source: string): Promise<{ header: Header; first: Tensor[]; rest: Tensor[]; plain: Buffer }> {
  const header = await readHeader(source);
  // Many small tensors (norms, attention and the first layers' weights) rather than one big one, so the
  // copy unlocked onto the computer stays small (~64 MB) while the model is useless without it.
  const chosen = new Set<Tensor>(); let bytes = 0n;
  for (const tensor of header.tensors) {
    if (bytes >= BigInt(firstSplitBytes)) { break; }
    if (tensor.size <= BigInt(maxLockedTensor) && chosen.size < header.tensors.length - 1) { chosen.add(tensor); bytes += tensor.size; }
  }
  if (!chosen.size) { chosen.add(header.tensors[0]!); }
  const first = header.tensors.filter((tensor) => chosen.has(tensor)); const rest = header.tensors.filter((tensor) => !chosen.has(tensor));
  const chunks: Buffer[] = [splitHeader(header, 0, 2, first, header.kv, header.kvCount)];
  for (const tensor of first) { chunks.push(await readRange(source, header.dataStart + Number(tensor.offset), tensor.size)); }
  return { header, first, rest, plain: Buffer.concat(chunks) };
}
/** Streams the second split to `out` and resolves with its size. */
async function writeRest(source: string, header: Header, rest: Tensor[], out: Writable): Promise<number> {
  let size = 0; const counted = new Transform({ transform(chunk: Buffer, _e, done) { size += chunk.length; done(null, chunk); } });
  const finished = pipeline(counted, out);
  counted.write(splitHeader(header, 1, 2, rest, header.alignmentKv ?? Buffer.alloc(0), header.alignmentKv ? 1n : 0n));
  for (const tensor of rest) {
    if (tensor.size === 0n) { continue; }
    const start = header.dataStart + Number(tensor.offset);
    for await (const chunk of createReadStream(source, { start, end: start + Number(tensor.size) - 1 })) { if (!counted.write(chunk)) { await once(counted, "drain"); } }
  }
  counted.end(); await finished; return size;
}
/** What a locked copy of `source` will contain, without writing anything: pinned in locked-models.ts. */
export async function splitDigest(source: string): Promise<SplitDigest> {
  const { header, first, rest, plain } = await planSplit(source);
  const hash = createHash("sha256");
  const restSize = await writeRest(source, header, rest, new Writable({ write(chunk: Buffer, _e, done) { hash.update(chunk); done(); } }));
  return { firstSha256: createHash("sha256").update(plain).digest("hex"), firstSize: plain.length, restSha256: hash.digest("hex"), restSize, tensorsInFirst: first.length };
}
/** Splits `source` into an encrypted first split and a plain rest, written beside `base` (a path without .gguf). */
export async function lockModel(source: string, base: string, key: Buffer, label: string): Promise<LockResult> {
  if (key.length !== 32) { throw new Error("A model key is 32 bytes."); }
  const { header, first, rest, plain } = await planSplit(source);
  const names = lockedNames(base); await mkdir(dirname(base), { recursive: true });
  const restTemp = `${names.rest}.tmp`; const hash = createHash("sha256");
  const file = createWriteStream(restTemp); await once(file, "open");
  const restSize = await writeRest(source, header, rest, new Writable({
    write(chunk: Buffer, _e, done) { hash.update(chunk); if (file.write(chunk)) { done(); } else { file.once("drain", () => done()); } },
    final(done) { file.end(() => done()); },
    destroy(error, done) { file.destroy(); done(error); }
  }));
  await rename(restTemp, names.rest);
  const lockedTemp = `${names.locked}.tmp`; await writeAll(lockedTemp, seal(plain, key, label)); await rename(lockedTemp, names.locked);
  return { locked: names.locked, rest: names.rest, firstSha256: createHash("sha256").update(plain).digest("hex"), firstSize: plain.length, restSha256: hash.digest("hex"), restSize, tensorsInFirst: first.length };
}
/** Locked file: "SLCK", version, 12-byte nonce, AES-256-GCM ciphertext, 16-byte tag (36 bytes of overhead). */
export const lockOverhead = 36;
export function seal(plain: Buffer, key: Buffer, label: string): Buffer {
  const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(Buffer.from(label));
  const prefix = Buffer.alloc(8); prefix.write(lockMagic, 0, "ascii"); prefix.writeUInt32LE(lockVersion, 4);
  return Buffer.concat([prefix, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
async function readRange(path: string, start: number, size: bigint): Promise<Buffer> {
  const file = await open(path, "r");
  try { const buffer = Buffer.alloc(Number(size)); const { bytesRead } = await file.read(buffer, 0, buffer.length, start); if (bytesRead !== buffer.length) { throw new Error("This GGUF file is damaged."); } return buffer; }
  finally { await file.close(); }
}
async function writeAll(path: string, data: Buffer): Promise<void> {
  const file = await open(path, "w", 0o644); try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
}

// ---------- Unlocking (the app, at start) ----------
export class ModelLockError extends Error { constructor(message: string) { super(message); this.name = "ModelLockError"; } }

/** Decrypts the first split into `folder` (the computer's temporary folder) and returns its path. */
export async function unlockModel(locked: string, folder: string, firstName: string, key: Buffer, label: string): Promise<string> {
  const file = await open(locked, "r");
  let sealed: Buffer;
  try {
    const size = (await file.stat()).size;
    if (size < 36 || size > 2 * 1024 * 1024 * 1024) { throw new ModelLockError("The locked model file is damaged."); }
    sealed = Buffer.alloc(size); await file.read(sealed, 0, size, 0);
  } finally { await file.close(); }
  if (sealed.toString("ascii", 0, 4) !== lockMagic || sealed.readUInt32LE(4) !== lockVersion) { throw new ModelLockError("The locked model file is damaged or from a newer app."); }
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(8, 20)); decipher.setAAD(Buffer.from(label));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    plain = Buffer.concat([decipher.update(sealed.subarray(20, sealed.length - 16)), decipher.final()]);
  } catch { throw new ModelLockError("This stick's model couldn't be unlocked. Activate the stick again, or contact support."); }
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, firstName); const temporary = `${path}.${process.pid}.tmp`;
  try { await writeAll(temporary, plain); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  return path;
}
