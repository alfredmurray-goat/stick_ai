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
      return result;
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
