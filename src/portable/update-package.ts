import { createReadStream } from "node:fs";
import { open, readFile, lstat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { join, dirname } from "node:path";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { hashFile, staticFiles, type Manifest } from "./integrity.js";
import { updateMagic, validateUpdateManifest } from "./update-format.js";
import type { Target } from "./platform.js";

export async function buildUpdateBundle(root: string, target: Target, output: string): Promise<void> {
  const manifest = validateUpdateManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")), target);
  const index = Buffer.from(JSON.stringify(manifest)); const length = Buffer.alloc(4); length.writeUInt32LE(index.length);
  async function* contents() {
    yield updateMagic; yield length; yield index;
    for (const record of manifest.files) {
      if (record.path.startsWith("models/")) { continue; }
      const path = join(root, record.path); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) { throw new Error("Unsafe update input"); }
      const actual = await hashFile(path);
      if (actual.size !== record.size || actual.sha256 !== record.sha256) { throw new Error("Changed update input"); }
      yield* createReadStream(path);
    }
  }
  await pipeline(Readable.from(contents()), createGzip(), createWriteStream(output, { flags: "wx", mode: 0o600 }));
}
export async function extractUpdateBundle(bundle: string, output: string, target: Target, signal: AbortSignal): Promise<Manifest> {
  const source = createReadStream(bundle, { signal }); const stream = source.pipe(createGunzip());
  source.on("error", (error) => stream.destroy(error));
  const iterator = stream[Symbol.asyncIterator](); let pending = Buffer.alloc(0); let offset = 0;
  const take = async (size: number): Promise<Buffer> => {
    const chunks: Buffer[] = []; let remaining = size;
    while (remaining) {
      signal.throwIfAborted();
      if (offset === pending.length) { const item = await iterator.next(); if (item.done) { throw new Error("Truncated update"); } pending = item.value; offset = 0; }
      const count = Math.min(remaining, pending.length - offset);
      chunks.push(pending.subarray(offset, offset + count)); offset += count; remaining -= count;
    }
    return Buffer.concat(chunks, size);
  };
  try {
    if (!(await take(8)).equals(updateMagic)) { throw new Error("Invalid update bundle"); }
    const length = (await take(4)).readUInt32LE(); if (length > 4000000) { throw new Error("Update index too large"); }
    const manifest = validateUpdateManifest(JSON.parse((await take(length)).toString("utf8")), target);
    for (const record of manifest.files) {
      if (record.path.startsWith("models/")) { continue; }
      const path = join(output, record.path); await mkdir(dirname(path), { recursive: true });
      const file = await open(path, "wx", 0o600); const hash = createHash("sha256");
      try {
        for (let remaining = record.size; remaining > 0;) {
          const bytes = await take(Math.min(65536, remaining)); hash.update(bytes); await file.writeFile(bytes); remaining -= bytes.length;
        }
        await file.sync();
      } finally { await file.close(); }
      if (hash.digest("hex") !== record.sha256) { throw new Error("Update file checksum failed"); }
      await chmod(path, record.executable ? 0o755 : 0o644);
    }
    if (offset !== pending.length || !(await iterator.next()).done) { throw new Error("Unlisted update data"); }
    await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    const actualFiles = await staticFiles(output);
    if (actualFiles.length !== manifest.files.filter((record) => !record.path.startsWith("models/")).length) { throw new Error("Unexpected update files"); }
    return manifest;
  } finally { source.destroy(); stream.destroy(); }
}
