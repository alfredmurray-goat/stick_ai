import { expect, it, vi } from "vitest";
import { compactHistory, taskMessage } from "../src/agent/index.js";
import { contextPlan, ManagedEngine } from "../src/portable/engine.js";
import { UserError } from "../src/portable/platform.js";
import type { Message } from "../src/model/types.js";

const GiB = 1024 ** 3;

it("sizes each model's window to the computer, and Long context mode raises both", () => {
  expect(contextPlan(8 * GiB)).toEqual({ lite: 65536, max: 8192, historyBytes: 49152, projectBytes: 8192 });
  expect(contextPlan(24 * GiB).max).toBe(16384);
  expect(contextPlan(32 * GiB).max).toBe(32768);
  expect(contextPlan(32 * GiB, true)).toEqual({ lite: 262144, max: 65536, historyBytes: 393216, projectBytes: 32768 });
  expect(contextPlan(16 * GiB, true).max).toBe(16384);
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
