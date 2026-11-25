import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatMemory, hostIndexKey } from "../src/portable/chat-memory.js";

// A stand-in for Stellan-Host's state store with the same rules: UUID keys, SHA-256 revisions,
// compare-and-swap saves (a stale revision is a conflict) and a 64 KiB limit.
function fakeHost() {
  const records = new Map<string, string>(); let opened = 0, closed = 0;
  const revision = (text: string | undefined) => text === undefined ? "missing" : createHash("sha256").update(text).digest("hex");
  const opener = async () => {
    opened++;
    return {
      closed: Promise.resolve(), get isClosed() { return false; },
      async get(key: string) { const text = records.get(key); return { exists: text !== undefined, revision: revision(text), text: text ?? "" }; },
      async put(key: string, expected: string, text: string) {
        if (expected !== revision(records.get(key))) { throw Object.assign(Error("State revision conflict; read and reconcile before saving"), { conflict: true }); }
        if (Buffer.byteLength(text) > 65536) { throw Error("State record exceeds 64 KiB"); }
        records.set(key, text); return { revision: revision(text) };
      },
      async close() { closed++; }
    };
  };
  return { records, opener, counts: () => ({ opened, closed }) };
}

it("keeps chat memory in Stellan-Host, carries file notes over once, and survives reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-memory-")), project = await mkdtemp(join(tmpdir(), "stick-project-"));
  try {
    // An older stick with file-based notes.
    const files = await ChatMemory.open(root, project);
    await files.record("Add a login page", "Added login.html and wired the form.", "finished");
    const chatId = files.view().id; await files.close();
    const host = fakeHost(); const binary = { executable: "/stick/bin/stellan-host", sha256: "a".repeat(64) };
    const memory = await ChatMemory.open(root, project, binary, host.opener as never);
    expect(memory.backend).toBe("host");
    expect(memory.view()).toMatchObject({ id: chatId, turns: 1, backend: "host" });
    expect(memory.recall()).toContain("Add a login page");
    expect(JSON.parse(host.records.get(hostIndexKey)!)).toMatchObject({ format: 1, current: chatId, enabled: true });
    await memory.record("Make the button blue", "Changed the button colour.", "finished");
    expect(JSON.parse(host.records.get(chatId)!).turns).toHaveLength(2);
    // Someone else changed the record: the next save re-reads once and still succeeds.
    host.records.set(chatId, JSON.stringify({ format: 1, turns: [] }));
    await memory.record("Third task", "Done.", "failed");
    expect(JSON.parse(host.records.get(chatId)!).turns.map((turn: { task: string }) => turn.task)).toContain("Third task");
    await memory.close();
    // Reopening reads Host, not the old files (the file copy is left untouched).
    const again = await ChatMemory.open(root, project, binary, host.opener as never);
    expect(again.view().turns).toBe(3);
    await again.forget(); expect(again.view().turns).toBe(0); expect(host.records.get(chatId)).toBe("");
    const third = await ChatMemory.open(root, project, binary, host.opener as never);
    expect(third.view().turns).toBe(0); expect(third.recall()).toBe("");
    await third.newChat(); expect(third.view().id).not.toBe(chatId);
    await third.close(); await again.close();
    expect(host.counts()).toEqual({ opened: 3, closed: 3 });
    const folder = join(await realpath(root), "logs", "chats");
    const keyFolder = (await readdir(folder))[0]!;
    expect((await readdir(join(folder, keyFolder))).sort()).toEqual([`${chatId}.json`, `${chatId}.md`, "index.json"]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); }
});

it("refuses malformed records from the store instead of trusting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-memory-")), project = await mkdtemp(join(tmpdir(), "stick-project-"));
  try {
    const host = fakeHost(); host.records.set(hostIndexKey, JSON.stringify({ format: 1, current: "../../etc", enabled: true }));
    await expect(ChatMemory.open(root, project, { executable: "/x", sha256: "a".repeat(64) }, host.opener as never)).rejects.toThrow(/Invalid chat memory index/);
    expect(host.counts().closed).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); }
});
it("saves the conversation in 64 KiB Host records under stable per-piece IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-memory-conv-")), project = await mkdtemp(join(tmpdir(), "stick-project-conv-"));
  try {
    const host = fakeHost(); const binary = { executable: "/stick/bin/stellan-host", sha256: "a".repeat(64) };
    const memory = await ChatMemory.open(root, project, binary, host.opener as never);
    const messages = Array.from({ length: 12 }, (_, n) => [{ role: "user" as const, content: `task ${n} ` + "x".repeat(30000) }, { role: "assistant" as const, content: `done ${n}` }]).flat();
    await memory.saveConversation(messages);
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    expect([...host.records.keys()].every(key => uuid.test(key))).toBe(true);
    expect([...host.records.values()].every(text => Buffer.byteLength(text) <= 65536)).toBe(true);
    await memory.close();
    const reopened = await ChatMemory.open(root, project, binary, host.opener as never);
    expect(await reopened.loadConversation()).toEqual(messages);
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); }
});
