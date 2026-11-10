import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { splitArchive, joinHelper } from "../scripts/release-parts.mjs";

it("splits a release below the per-file limit and rejoins it after checking every hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-release-test-"));
  try {
    const input = join(root, "stick_ai-test.zip"); const content = Buffer.from("Stellan Lite archive fixture ".repeat(100)); await writeFile(input, content);
    const output = join(root, "parts"); const record = await splitArchive(input, output, 1000);
    expect(record.parts.length).toBeGreaterThan(1); expect(record.parts.every((part) => part.size <= 1000)).toBe(true);
    const combined = Buffer.concat(await Promise.all(record.parts.map((part) => readFile(join(output, part.name))))); expect(combined).toEqual(content);
    const platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
    const helper = await joinHelper(record, output, platform); const execute = promisify(execFile);
    const run = async () => {
      const result = process.platform === "win32" ? execute(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `\"\"${join(output, helper)}\"\"`], { windowsVerbatimArguments: true, timeout: 10000 }) : execute(join(output, helper), [], { timeout: 10000 });
      if (process.platform === "win32") { result.child.stdin.end("\r\n"); }
      return result.catch(error => { console.error("Join diagnostic", error.stdout, error.stderr); throw error; });
    };
    await writeFile(join(output, record.parts[0].name), "tampered"); await expect(run()).rejects.toThrow();
    await expect(readFile(join(output, record.name))).rejects.toThrow();
    await writeFile(join(output, record.parts[0].name), combined.subarray(0, record.parts[0].size));
    await run(); expect(await readFile(join(output, record.name))).toEqual(content);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses oversized parts and unsafe release names", async () => {
  await expect(splitArchive("stick_ai-test.zip", "unused", 2 * 1024 ** 3)).rejects.toThrow("Invalid");
  await expect(splitArchive("untrusted$.zip", "unused", 100)).rejects.toThrow("Unsafe");
});

it("uploads and removes each finished part before writing the next, bounding publishing disk use", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-release-stream-"));
  try {
    const input = join(root, "stick_ai-full.zip"); const content = Buffer.from("weights ".repeat(1000)); await writeFile(input, content);
    const uploaded = [];
    const record = await splitArchive(input, join(root, "parts"), 1000, async (part, path) => {
      const bytes = await readFile(path); expect(bytes.length).toBe(part.size); uploaded.push(bytes); await rm(path);
    });
    expect(uploaded).toHaveLength(record.parts.length); expect(Buffer.concat(uploaded)).toEqual(content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('supports actual DMG images without wrapping them in a ZIP', async () => {
  const root=await mkdtemp(join(tmpdir(),'stick-dmg-parts-'));
  try {
    const input=join(root,'stick_ai-macos-x64-lite-picker.dmg');
    await writeFile(input,Buffer.from('native disk image fixture'));
    const record=await splitArchive(input,join(root,'parts'),8);
    expect(record.name).toBe('stick_ai-macos-x64-lite-picker.dmg');
    expect(record.parts[0].name).toBe('stick_ai-macos-x64-lite-picker.dmg.part01');
    const helper=await joinHelper(record,join(root,'parts'),'macos-x64');
    expect(helper).toBe('Join-stick_ai-macos-x64-lite-picker.command');
  } finally { await rm(root,{recursive:true,force:true}); }
});
