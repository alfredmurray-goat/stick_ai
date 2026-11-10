import { mkdir, rm, statfs } from "node:fs/promises";
import { splitArchive } from "./release-parts.mjs";
export function partBatchSize(freeBytes, limit = 2000 * 1024 ** 2) {
  return Number.isFinite(freeBytes) ? Math.max(1, Math.min(3, Math.floor((freeBytes - 1024 ** 3) / limit))) : 1;
}
export async function uploadSplitArchive(input, output, uploadBatch, limit = 2000 * 1024 ** 2) {
  await mkdir(output, { recursive: true });
  const disk = await statfs(output), batchSize = partBatchSize(disk.bavail * disk.bsize, limit), pending = [];
  async function flush() {
    if (!pending.length) { return; }
    // gh release upload uses its bounded concurrent uploader for these file arguments.
    // Await the complete batch before deleting its files or staging more parts.
    await uploadBatch([...pending]);
    for (const path of pending) { await rm(path); }
    pending.length = 0;
  }
  const record = await splitArchive(input, output, limit, async (_record, path) => {
    pending.push(path); if (pending.length >= batchSize) { await flush(); }
  });
  await flush(); return record;
}
