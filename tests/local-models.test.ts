import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectMaxFile, linkMaxFile, localModelStatus, resolveLocalMax, unlinkMaxFile } from "../src/portable/local-models.js";
const roots: string[] = []; const GiB = 1024 ** 3;
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const drive = await mkdtemp(join(tmpdir(), "stick-local-max-")); roots.push(drive); const root = join(drive, "Stick AI"); await mkdir(root);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ files: [] }));
  const model = join(drive, "My Stellan Max.gguf"); const bytes = Buffer.alloc(64); bytes.write("GGUF"); bytes.writeUInt32LE(3, 4); bytes.writeBigUInt64LE(1n, 8);
  await writeFile(model, bytes); return { drive, root, model, bytes };
}
it("links an external GGUF without moving or copying it into the app", async () => {
  const f = await fixture(); const inode = (await stat(f.model)).ino;
  await linkMaxFile(f.root, f.model);
  expect((await resolveLocalMax(f.root))?.path).toBe(await import("node:fs/promises").then((fs) => fs.realpath(f.model)));
  expect((await stat(f.model)).ino).toBe(inode);
  expect(await readFile(f.model)).toEqual(f.bytes);
  await expect(stat(join(f.root, "models"))).rejects.toThrow();
  const status = await localModelStatus(f.root, 16 * GiB); expect(status.available).toBe(true); expect(status.eligible).toBe(true);
});
it("keeps the selected file portable when the whole stick folder moves", async () => {
  const f = await fixture(); await linkMaxFile(f.root, f.model);
  expect(JSON.parse(await readFile(join(f.root, "logs/max-model.json"), "utf8")).relative).toBe(true);
  const moved = f.drive + "-moved"; await rename(f.drive, moved); roots.push(moved);
  const model = await resolveLocalMax(join(moved, "Stick AI")); expect(model?.path).toBe(resolve(moved, "My Stellan Max.gguf"));
});
it("refuses an incomplete or wrong-format file without losing the prior choice", async () => {
  const f = await fixture(); await linkMaxFile(f.root, f.model);
  const bad = join(f.drive, "broken.gguf"); await writeFile(bad, "GGUF");
  await expect(linkMaxFile(f.root, bad)).rejects.toThrow("complete GGUF");
  expect((await resolveLocalMax(f.root))?.name).toBe("My Stellan Max.gguf");
  await expect(inspectMaxFile(join(f.drive, "model.safetensors"))).rejects.toThrow(".gguf");
});
it("shows an unavailable or changed file without preventing Lite use", async () => {
  const f = await fixture(); await linkMaxFile(f.root, f.model); await writeFile(f.model, Buffer.concat([f.bytes, Buffer.from("changed")]));
  expect((await localModelStatus(f.root, 32 * GiB)).message).toContain("changed");
  await rm(f.model); const status = await localModelStatus(f.root, 32 * GiB); expect(status.available).toBe(false); expect(status.message).toContain("missing");
});
it("retains the 16 GiB threshold even with weights selected", async () => {
  const f = await fixture(); await linkMaxFile(f.root, f.model);
  for (const bytes of [8 * GiB, 16 * GiB - 1]) { const status = await localModelStatus(f.root, bytes); expect(status.available).toBe(true); expect(status.eligible).toBe(false); }
  expect((await localModelStatus(f.root, 16 * GiB)).eligible).toBe(true);
});
it("falls back to included Max when an external selection is removed, keeping both files intact", async () => {
  const f = await fixture(); await mkdir(join(f.root, "models")); const bundled = join(f.root, "models/stellan-1-max-q4_k_m.gguf"); await writeFile(bundled, f.bytes);
  await writeFile(join(f.root, "manifest.json"), JSON.stringify({ files: [{ path: "models/stellan-1-max-q4_k_m.gguf" }] }));
  await linkMaxFile(f.root, f.model); expect((await resolveLocalMax(f.root))?.source).toBe("linked");
  await unlinkMaxFile(f.root); expect((await resolveLocalMax(f.root))?.source).toBe("bundled");
  expect(await readFile(f.model)).toEqual(f.bytes); expect(await readFile(bundled)).toEqual(f.bytes);
});
it("refuses an unlisted file placed inside the verified app package", async () => {
  const f = await fixture(); const inside = join(f.root, "extra.gguf"); await writeFile(inside, f.bytes);
  await expect(linkMaxFile(f.root, inside)).rejects.toThrow("outside the app folder");
});
