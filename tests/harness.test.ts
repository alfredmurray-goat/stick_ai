import { expect, it, vi } from "vitest";
import { compactHistory, taskMessage } from "../src/agent/index.js";
import { contextPlan, ManagedEngine } from "../src/portable/engine.js";
import { UserError } from "../src/portable/platform.js";
import type { Message } from "../src/model/types.js";

const GiB = 1024 ** 3;

it("sizes each model's window to the computer, and Long context mode raises both", () => {
  expect(contextPlan(8 * GiB)).toEqual({ lite: 65536, max: 8192, historyBytes: 49152, projectBytes: 8192 });
  expect(contextPlan(24 * GiB).max).toBe(8192);
  expect(contextPlan(32 * GiB).max).toBe(8192);
  expect(contextPlan(32 * GiB, true)).toEqual({ lite: 262144, max: 65536, historyBytes: 393216, projectBytes: 32768 });
  expect(contextPlan(16 * GiB, true).max).toBe(16384);
  expect(contextPlan(24 * GiB, true).max).toBe(32768);
});

function conversation(tasks: number, padding: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < tasks; i++) {
    messages.push({ role: "user", content: `Task ${i}: fix bug ${i}` });
    messages.push({ role: "assistant", content: `<tool_call>{"name":"read_file","arguments":{"path":"src/file${i}.ts"}}</tool_call>` });
    messages.push({ role: "user", content: `<tool_result>${"x".repeat(padding)}</tool_result>` });
    messages.push({ role: "assistant", content: `<done>Fixed bug ${i} in src/file${i}.ts.</done>` });
  }
  return messages;
}

it("summarises older tasks, keeps recent ones word for word, and leaves short conversations alone", () => {
  const short = conversation(3, 100);
  expect(compactHistory(short, 10000)).toBe(0); expect(short).toHaveLength(12);

  const long = conversation(10, 2000);
  const summarised = compactHistory(long, 8000);
  expect(summarised).toBeGreaterThan(0);
  expect(long[0]!.content).toContain("<conversation_summary>");
  expect(long[0]!.content).toContain('The user asked: "Task 0: fix bug 0"');
  expect(long[0]!.content).toContain("read_file src/file0.ts");
  expect(long[0]!.content).toContain("Your answer: Fixed bug 0 in src/file0.ts.");
  expect(long[1]).toEqual({ role: "assistant", content: expect.stringContaining("<done>") });
  // The newest task is kept exactly, and everything fits in the budget again.
  expect(long.at(-4)!.content).toBe("Task 9: fix bug 9"); expect(long.at(-2)!.content).toBe(`<tool_result>${"x".repeat(2000)}</tool_result>`);
  expect(long.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0)).toBeLessThanOrEqual(8000);

  // A later compaction folds the earlier summary in instead of stacking summaries.
  long.push(...conversation(10, 2000).map((message) => ({ ...message, content: message.content.replace(/Task (\d)/, "Later $1") })));
  compactHistory(long, 8000);
  expect(long.filter((message) => message.content.startsWith("<conversation_summary>"))).toHaveLength(1);
  expect(long[0]!.content).toContain("Later 0");
  // The summary has its own cap (a quarter of the budget); the oldest lines go first.
  expect(Buffer.byteLength(long[0]!.content)).toBeLessThanOrEqual(8000 / 4 + 400);
});

it("sends the project file list again after compaction removed the copy the model had seen", () => {
  const history: Message[] = [];
  const list = { list: "Project file list:\na.ts\n", named: "" };
  history.push({ role: "user", content: taskMessage("first", history, list) }, { role: "assistant", content: "<done>" + "y".repeat(5000) + "</done>" });
  history.push({ role: "user", content: taskMessage("second", history, list) }, { role: "assistant", content: "<done>ok</done>" });
  expect(history[2]!.content).toBe("second");
  compactHistory(history, 2000);
  expect(taskMessage("third", history, list)).toContain("Project file list");
});

it("starts Max once more without its speed settings if the llama.cpp build refuses them", async () => {
  const engine = new ManagedEngine("fixture", "linux-x64", 8080, "temp", -1, vi.fn());
  const launches: boolean[] = [];
  (engine as unknown as { launch: (model: string, signal: AbortSignal, gpu: string[]) => Promise<void> }).launch = async () => {
    launches.push(engine.plainFallback); if (!engine.plainFallback) throw new UserError("loading"); engine.active = "stellan-1-max";
  };
  await engine.start("stellan-1-max", new AbortController().signal);
  expect(launches).toEqual([false, true]); expect(engine.active).toBe("stellan-1-max");
  const lite = new ManagedEngine("fixture", "linux-x64", 8080, "temp", -1, vi.fn());
  (lite as unknown as { launch: () => Promise<void> }).launch = async () => { throw new UserError("loading"); };
  await expect(lite.start("stellan-1-lite", new AbortController().signal)).rejects.toThrow();
  expect(lite.plainFallback).toBe(false);
});

it("remembers on the stick that the welcome tour was seen, and keeps Long context mode", async () => {
  const { mkdtemp, cp, rm } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { webApp } = await import("../src/portable/web.js");
  const root = await mkdtemp(join(tmpdir(), "stick-tour-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const engine = { active: null as string | null, baseUrl: "http://127.0.0.1:9", key: "k", plan: contextPlan(16 * GiB), async start(model: string) { this.active = model; }, async stop() { this.active = null; } };
  const open = async () => {
    const app = await webApp({ root, engine: engine as unknown as ManagedEngine, bytes: 16 * GiB, choices: ["stellan-1-lite"], noSwap: true, report: vi.fn(), log: vi.fn(), stop: async () => {} });
    const url = new URL(app.url);
    const api = async (path: string, data?: object): Promise<any> => (await fetch(url.origin + path, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) })).json();
    return { app, api };
  };
  try {
    const first = await open();
    expect((await first.api("/api/state")).onboarded).toBe(false);
    await first.api("/api/onboarded", {}); await first.api("/api/long-context", { enabled: true });
    expect(await first.api("/api/state")).toMatchObject({ onboarded: true, longContext: true, contextTokens: { lite: 262144, max: 16384 } });
    await first.app.close();
    const second = await open();
    expect(await second.api("/api/state")).toMatchObject({ onboarded: true, longContext: true });
    await second.app.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps Max loaded beside Lite only where both fit, and on a Mac GPU only with room to spare", async () => {
  const { keepsBothLoaded } = await import("../src/portable/engine.js");
  expect(keepsBothLoaded("linux-x64", 16 * GiB)).toBe(false);
  expect(keepsBothLoaded("windows-x64", 31 * GiB)).toBe(true);
  expect(keepsBothLoaded("macos-arm64", 32 * GiB, {})).toBe(false);
  expect(keepsBothLoaded("macos-arm64", 32 * GiB, { STICK_GPU: "0" })).toBe(true);
  expect(keepsBothLoaded("macos-arm64", 64 * GiB, {})).toBe(true);
  expect(keepsBothLoaded("linux-x64", 64 * GiB, { STICK_KEEP_BOTH: "0" })).toBe(false);
});

it("loads Max once beside Lite and reuses it, and falls back to swapping if it won't start", async () => {
  const lite = new ManagedEngine("fixture", "linux-x64", 8080, "temp", -1, vi.fn());
  const coder = new ManagedEngine("fixture", "linux-x64", 8081, "temp/max", -1, vi.fn());
  const starts: string[] = []; let stops = 0;
  (coder as unknown as { launch: (model: "stellan-1-max") => Promise<void> }).launch = async (model) => { starts.push(model); coder.active = model; };
  coder.stop = async () => { stops++; coder.active = null; };
  lite.coder = coder; lite.active = "stellan-1-lite";
  const signal = new AbortController().signal; const report = vi.fn();
  expect(await lite.loadedCoder(signal, report)).toBe(coder);
  expect(await lite.loadedCoder(signal, report)).toBe(coder);
  expect(starts).toEqual(["stellan-1-max"]); expect(lite.active).toBe("stellan-1-lite"); expect(report).toHaveBeenCalledTimes(1);
  await lite.stop(); expect(stops).toBe(1);
  (coder as unknown as { launch: () => Promise<void> }).launch = async () => { throw new UserError("loading"); };
  coder.plainFallback = true;
  expect(await lite.loadedCoder(signal, report)).toBeUndefined(); expect(lite.coder).toBeUndefined();
});
