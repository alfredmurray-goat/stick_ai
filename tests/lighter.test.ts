import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GiB } from "../src/config/models.js";
import { taskMessage } from "../src/agent/index.js";
import { boundedToolHistory, contextMark } from "../src/agent/context.js";
import type { Message } from "../src/model/types.js";
import { webApp } from "../src/portable/web.js";
import type { ManagedEngine } from "../src/portable/engine.js";
import { listenLocal } from "../src/portable/ports.js";

afterEach(() => { delete process.env.STICK_REST_MINUTES; });

it("sends the project file list with a task only when it changed in this conversation", () => {
  const history: Message[] = [];
  const first = taskMessage("Explain add", history, { list: "Project file list:\nutils.js\n", named: "" });
  expect(first).toBe(`Explain add${contextMark}Project file list:\nutils.js\n</project_context>`);
  history.push({ role: "user", content: first }, { role: "assistant", content: "<done>It adds.</done>" });
  expect(taskMessage("And now?", history, { list: "Project file list:\nutils.js\n", named: "" })).toBe("And now?");
  expect(taskMessage("Read it", history, { list: "Project file list:\nutils.js\n", named: "\nNamed file: utils.js\nexport {}\n" })).toBe(`Read it${contextMark}\nNamed file: utils.js\nexport {}\n</project_context>`);
  expect(taskMessage("After a write", history, { list: "Project file list:\nnew.js\nutils.js\n", named: "" })).toContain("new.js");
  // A new conversation reuses the same array after clearing it; the list must be sent again.
  history.length = 0;
  expect(taskMessage("Fresh", history, { list: "Project file list:\nnew.js\nutils.js\n", named: "" })).toContain("Project file list");
  expect(taskMessage("With a skill", [], { list: "", named: "" }, "Skill: review carefully")).toBe("With a skill\n\nSkill: review carefully");
});

it("trims old project context but never the words of a task", () => {
  const big = "x".repeat(6000);
  const history: Message[] = [
    { role: "system", content: "System" },
    { role: "user", content: `First task${contextMark}${big}</project_context>` },
    { role: "assistant", content: "<done>ok</done>" },
    { role: "user", content: "Second task" }
  ];
  const sent = boundedToolHistory(history, 1024);
  expect(sent[1]!.content.startsWith(`First task${contextMark}`)).toBe(true);
  expect(sent[1]!.content.length).toBeLessThan(1200);
  expect(sent[3]!.content).toBe("Second task");
  expect(history[1]!.content.length).toBeGreaterThan(6000);
});

it("pre-reads the system message, holds idle state requests, rests when quiet and wakes with the conversation", async () => {
  process.env.STICK_REST_MINUTES = "0.01";
  const root = await mkdtemp(join(tmpdir(), "stick-lighter-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const bodies: any[] = [];
  const inference = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) { text += chunk; } bodies.push(JSON.parse(text));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "<done>Hello.</done>" }, finish_reason: "stop" }] })}\n\n`);
  });
  const port = await listenLocal(inference);
  const calls: string[] = []; let warmedWith = "";
  const engine = {
    active: null as string | null, baseUrl: `http://127.0.0.1:${port}`, key: "test-key",
    async start(model: string) { calls.push(`start ${model}`); this.active = model; },
    async stop() { calls.push("stop"); this.active = null; },
    async warm(system: string) { calls.push("warm"); warmedWith = system; return true; },
    async restoreSystem(system: string) { calls.push("restore system"); return system === warmedWith; },
    async saveLiteCache() { calls.push("save"); return true; },
    async restoreLiteCache() { calls.push("restore conversation"); return true; }
  };
  const app = await webApp({ root, engine: engine as unknown as ManagedEngine, bytes: 8 * GiB, choices: ["stellan-1-lite"], noSwap: true, report: vi.fn(), log: vi.fn(), stop: async () => {} });
  const url = new URL(app.url);
  const api = async (path: string, data?: object): Promise<any> => (await fetch(url.origin + path, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) })).json();
  try {
    await app.start("stellan-1-lite");
    await vi.waitFor(() => expect(calls).toContain("warm"));
    await vi.waitFor(async () => expect((await api("/api/state")).resting).toBe(true), { timeout: 5000 });
    expect(calls).toEqual(["start stellan-1-lite", "warm", "save", "stop"]);
    // An idle window's request is held until something happens instead of returning at once.
    const idle = await api("/api/state"); const asked = Date.now();
    const held = api(`/api/state?after=${idle.events.at(-1)?.id ?? 0}&wait=${encodeURIComponent(idle.key)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await api("/api/task", { text: "Say hello" });
    const woken = await held; expect(Date.now() - asked).toBeGreaterThanOrEqual(250);
    expect(woken.events.some((event: any) => event.kind === "user" && event.text === "Say hello")).toBe(true);
    await vi.waitFor(async () => expect((await api("/api/state")).events.some((event: any) => event.kind === "task-complete")).toBe(true));
    expect(calls.slice(4, 6)).toEqual(["start stellan-1-lite", "restore conversation"]);
    // The system message Lite receives is exactly what was pre-read, so the server can reuse it.
    expect(bodies[0].messages[0].content).toBe(warmedWith);
    expect(bodies[0].messages[1].content.startsWith("Say hello")).toBe(true);
    await vi.waitFor(async () => expect((await api("/api/state")).resting).toBe(true), { timeout: 5000 });
    await api("/api/session/reset", {});
    await api("/api/task", { text: "Again" });
    await vi.waitFor(async () => expect((await api("/api/state")).events.some((event: any) => event.kind === "task-complete")).toBe(true));
    // After a new conversation there is no conversation to bring back: Lite starts from the pre-read instructions.
    expect(calls.slice(-3)).toEqual(["stop", "start stellan-1-lite", "restore system"]);
  } finally { await app.close(); inference.closeAllConnections(); await new Promise<void>((resolve) => inference.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30000);
