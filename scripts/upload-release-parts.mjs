import {setTimeout as delay} from 'node:timers/promises';
import { mkdir, rm, statfs } from "node:fs/promises";
import { splitArchive } from "./release-parts.mjs";
export function partBatchSize(freeBytes, limit = 2000 * 1024 ** 2) {
  return Number.isFinite(freeBytes) ? Math.max(1, Math.min(3, Math.floor((freeBytes - 1024 ** 3) / limit))) : 1;
}
export async function uploadBatchWithRetry(paths,upload,pause=delay) {
  for(let attempt=0;attempt<3;attempt++) {
    try {await upload([...paths]);return;}
    catch(error) {
      const diagnostic=String(error.stderr??error.message??error);
      if(attempt===2||!/HTTP (?:408|429|5\d\d)\b|ECONNRESET|connection reset|TLS handshake timeout/i.test(diagnostic))throw error;
      console.log(`Release upload was interrupted; retrying the same verified parts (${attempt+2}/3)`);
      await pause(5000*(attempt+1));
    }
  }
}
export async function uploadSplitArchive(input, output, uploadBatch, limit = 2000 * 1024 ** 2) {
  await mkdir(output, { recursive: true });
  const disk = await statfs(output), batchSize = partBatchSize(disk.bavail * disk.bsize, limit), pending = [];
  async function flush() {
    if (!pending.length) { return; }
    // gh release upload uses its bounded concurrent uploader for these file arguments.
    // Await the complete batch before deleting its files or staging more parts.
    await uploadBatchWithRetry(pending,uploadBatch);
    for (const path of pending) { await rm(path); }
    pending.length = 0;
  }
  const record = await splitArchive(input, output, limit, async (_record, path) => {
    pending.push(path); if (pending.length >= batchSize) { await flush(); }
  });
  await flush(); return record;
}
