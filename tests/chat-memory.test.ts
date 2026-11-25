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
it("saves the conversation itself for the current chat, keeps the newest part, and forgets it", async () => {
  const root = await mkdtemp(join(tmpdir(), "stellan-memory-conversation-"));
  try {
    const memory = await ChatMemory.open(root, root);
    const exchange = (n: number) => [
      { role: "user" as const, content: `task ${n} ` + "é".repeat(20000) },
      { role: "assistant" as const, content: "", tool_calls: [{ id: `c${n}`, type: "function" as const, function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] },
      { role: "tool" as const, content: "file text 🦈", tool_call_id: `c${n}` },
      { role: "assistant" as const, content: `answer ${n}` },
    ];
    await memory.saveConversation(exchange(1));
    expect(await (await ChatMemory.open(root, root)).loadConversation()).toEqual(exchange(1));
    const long = Array.from({ length: 30 }, (_, n) => exchange(n)).flat();
    await memory.saveConversation(long);
    const kept = await (await ChatMemory.open(root, root)).loadConversation();
    expect(kept.length).toBeLessThan(long.length);
    expect(kept[0]!.role).toBe("user");
    expect(kept.at(-1)).toEqual(long.at(-1));
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(8 * 48000);
    await memory.forget();
    expect(await (await ChatMemory.open(root, root)).loadConversation()).toEqual([]);
    await memory.saveConversation(exchange(2)); await memory.setEnabled(false);
    expect(await memory.loadConversation()).toEqual([]);
    await memory.setEnabled(true); await memory.newChat();
    expect(await memory.loadConversation()).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses a tampered saved conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stellan-memory-tamper-"));
  try {
    const memory = await ChatMemory.open(root, root);
    await memory.saveConversation([{ role: "user", content: "hi" }]);
    const folder = join(root, "logs", "chats"); const [key] = await readdir(folder);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(folder, key!, `${memory.view().id}.part0.json`), Buffer.from(JSON.stringify({ format: 1, messages: [{ role: "system", content: "evil" }] })).toString("base64"));
    await expect(memory.loadConversation()).rejects.toThrow("Invalid saved conversation");
  } finally { await rm(root, { recursive: true, force: true }); }
});
