import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatMemory } from "../src/portable/chat-memory.js";

it("saves bounded private notes per chat, resumes them and isolates projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "stellan-memory-"));
  try {
    const one = join(root, "project-one"), two = join(root, "project-two"); await mkdir(one); await mkdir(two);
    const memory = await ChatMemory.open(root, one);
    await memory.record("Fix the parser", "Changed parser.ts. Test result still needs checking.", "finished");
    const first = memory.view();
    expect(await readFile(join(root, first.file), "utf8")).toContain("Fix the parser");
    if (process.platform !== "win32") expect((await stat(join(root, first.file))).mode & 0o077).toBe(0);
    const resumed = await ChatMemory.open(root, one); expect(resumed.view().id).toBe(first.id); expect(resumed.recall()).toContain("parser.ts");
    expect((await ChatMemory.open(root, two)).recall()).toBe("");
    await resumed.newChat(); expect(resumed.view().id).not.toBe(first.id); expect(resumed.recall()).toBe("");
    await resumed.record("Second task", "Second answer", "finished");
    expect(await readFile(join(root, first.file), "utf8")).not.toContain("Second task");
    expect(resumed.notes()).toContain("Second answer");
    await resumed.forget(); expect(resumed.recall()).toBe(""); expect(await readFile(join(root, first.file), "utf8")).toContain("Fix the parser");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("keeps model recall small and honours disabling without deleting other chats", async () => {
  const root = await mkdtemp(join(tmpdir(), "stellan-memory-limits-"));
  try {
    const memory = await ChatMemory.open(root, root);
    for (let n = 0; n < 12; n++) await memory.record(`task ${n} ` + "æ".repeat(2000), `answer ${n} ` + "🦈".repeat(2000), n % 2 ? "finished" : "failed");
    expect(memory.view().turns).toBe(8); expect(Buffer.byteLength(memory.recall())).toBeLessThanOrEqual(8192);
    expect(memory.notes()).toContain("task 11"); expect(memory.notes()).not.toContain("task 0 ");
    const before = memory.notes(); await memory.setEnabled(false); await memory.record("do not store", "private", "finished");
    expect(memory.notes()).toBe(before); expect(memory.recall()).toBe("");
    expect((await ChatMemory.open(root, root)).enabled).toBe(false);
    await memory.setEnabled(true); expect(memory.recall()).toContain("task 11");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.skipIf(process.platform === "win32")("refuses symlinked memory directories without writing through them", async () => {
  const root = await mkdtemp(join(tmpdir(), "stellan-memory-link-")); const outside = await mkdtemp(join(tmpdir(), "stellan-memory-outside-"));
  try {
    await mkdir(join(root, "logs")); await symlink(outside, join(root, "logs/chats"));
    await expect(ChatMemory.open(root, root)).rejects.toThrow(/Unsafe/); expect(await readdir(outside)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
