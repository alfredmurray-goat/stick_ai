import { expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { partBatchSize, uploadSplitArchive } from "../scripts/upload-release-parts.mjs";
it("bounds staging to available disk and at most three parts", () => {
  const limit = 2000 * 1024 ** 2;
  expect(partBatchSize(1024 ** 3 + limit - 1)).toBe(1);
  expect(partBatchSize(1024 ** 3 + limit * 2)).toBe(2);
  expect(partBatchSize(100 * 1024 ** 3)).toBe(3);
  expect(partBatchSize(NaN)).toBe(1);
});
it("uploads complete bounded batches and the final partial batch before returning, then removes staged parts", async () => {
  const folder = await mkdtemp(join(tmpdir(), "stick-batch-test-"));
  try {
    const bytes = Buffer.from("0123456789".repeat(4) + "abcde"), input = join(folder, "stick_ai-linux-x64.tar.gz"), output = join(folder, "parts");
    await writeFile(input, bytes); const sizes = [], received = [];
    const record = await uploadSplitArchive(input, output, async (paths) => {
      sizes.push(paths.length); expect((await readdir(output)).length).toBeLessThanOrEqual(3);
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const path of paths) { received.push(await readFile(path)); }
    }, 10);
    expect(sizes).toEqual([3, 2]); expect(Buffer.concat(received)).toEqual(bytes);
    expect(record.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(record.parts).toHaveLength(5); expect(await readdir(output)).toEqual([]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it("stops splitting on an upload failure and does not return a publishable record", async () => {
  const folder = await mkdtemp(join(tmpdir(), "stick-batch-failure-"));
  try {
    const input = join(folder, "stick_ai-linux-x64.tar.gz"), output = join(folder, "parts"); await writeFile(input, Buffer.alloc(100));
    let calls = 0;
    await expect(uploadSplitArchive(input, output, async () => { calls++; throw new Error("upload failed"); }, 10)).rejects.toThrow("upload failed");
    expect(calls).toBe(1); expect((await readdir(output)).length).toBe(3);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
