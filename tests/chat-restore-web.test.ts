import { expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { webApp } from "../src/portable/web.js";
import { ChatMemory } from "../src/portable/chat-memory.js";
import type { ManagedEngine } from "../src/portable/engine.js";

it("shows the current chat again after a restart, from its saved notes, and not after New conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-chat-restore-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const project = join(root, "app/project"); await mkdir(project, { recursive: true });
  const memory = await ChatMemory.open(root, await realpath(project));
  await memory.record("Make the header blue", "Changed header.css to blue.", "finished");
  await memory.record("Add a footer", "", "cancelled");
  await memory.close();
  const app = await webApp({ root, engine: { active: null } as unknown as ManagedEngine, bytes: 8 * 1024 ** 3, choices: ["stellan-1-lite"], noSwap: false, report: vi.fn(), log: vi.fn(), stop: async () => {} });
  const url = new URL(app.url);
  const api = async (path: string, body?: object) => { const response = await fetch(url.origin + path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + url.hash.slice(1), Origin: url.origin, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  try {
    const events = (await api("/api/state")).data.events as { kind: string; text?: string }[];
    expect(events.map(event => [event.kind, event.text])).toEqual([
      ["restored", "Earlier in this chat (2 saved turns; long answers are shortened)"],
      ["user", "Make the header blue"], ["answer", "Changed header.css to blue."],
      ["user", "Add a footer"], ["answer", "This task was stopped before it finished."],
    ]);
    expect((await api("/api/session/reset", {})).status).toBe(200);
    const fresh = (await api("/api/state")).data.events as { kind: string }[];
    expect(fresh.some(event => event.kind === "restored" || event.kind === "user")).toBe(false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
