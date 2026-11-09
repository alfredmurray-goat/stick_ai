import { expect, it, vi } from "vitest";
import { runAgent } from "../src/agent/index.js";
import { createDelegate } from "../src/agent/delegate.js";
import { codeWithSwap } from "../src/portable/engine.js";
import { GiB } from "../src/config/models.js";
import { parseStep } from "../src/model/protocol.js";
import type { Call, Message, Model } from "../src/model/types.js";

const request: Call = { id: "1", type: "function", function: { name: "delegate_code", arguments: JSON.stringify({ task: "Write greet", context: "TypeScript" }) } };
it("validates delegate_code as an allowed tool name", () => {
  expect(parseStep(`<tool_call>{"name":"delegate_code","arguments":{"task":"code","context":"source"}}</tool_call>`).step.kind).toBe("call");
  expect(parseStep('<tool_call>{"name":"another_tool","arguments":{}}</tool_call>').step.kind).toBe("error");
});
it("Lite delegates, receives Max code, applies it and alone finishes", async () => {
  const replies = [
    `<tool_call>{"name":"delegate_code","arguments":{"task":"Write greet","context":"TypeScript"}}</tool_call>`,
    `<tool_call>{"name":"write_file","arguments":{"path":"greet.ts","content":"export function greet() { return 1; }"}}</tool_call>`,
    "<done>Applied and checked</done>"
  ];
  const model: Model = { complete: vi.fn(async () => ({ content: replies.shift()!, calls: [] })) };
  const code = vi.fn(async () => "export function greet() { return 1; }");
  const execute = vi.fn(async (_call: Call, _signal: AbortSignal) => "Wrote 37 bytes to greet.ts");
  const messages: Message[] = [];
  await runAgent({ task: "Make greet", messages, model, tools: { execute }, specialist: { totalBytes: 16 * GiB, noSwap: false, available: true, code }, maxSteps: 10, signal: new AbortController().signal, emit: vi.fn(), log: vi.fn(), save: async () => {} });
  expect(code).toHaveBeenCalledWith("Write greet", "TypeScript", expect.any(AbortSignal));
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]?.[0].function.name).toBe("write_file");
  expect(messages[2]?.content).toBe("<tool_result>export function greet() { return 1; }</tool_result>");
  expect(messages.at(-1)?.content).toBe("<done>Applied and checked</done>");
});
it("stops Lite, starts Max, stops Max and restarts Lite without changing history", async () => {
  const sequence: string[] = []; const history = [{ role: "user", content: "original task" }];
  const original = structuredClone(history);
  const engine = { stop: vi.fn(async () => { sequence.push("stop"); }), start: vi.fn(async (model: string) => { sequence.push(model); }) };
  const result = await codeWithSwap(engine, async () => "code", new AbortController().signal, vi.fn());
  expect(sequence).toEqual(["stop", "stellan-1-max", "stop", "stellan-1-lite"]);
  expect(result).toBe("code"); expect(history).toEqual(original);
  expect(engine.start.mock.calls.every((args) => args[0])).toBe(true);
});
it("restores Lite even if Max fails", async () => {
  const sequence: string[] = [];
  const engine = { stop: async () => { sequence.push("stop"); }, start: async (model: string) => { sequence.push(model); } };
  await expect(codeWithSwap(engine, async () => { throw new Error("coder failed"); }, new AbortController().signal, vi.fn())).rejects.toThrow("coder failed");
  expect(sequence.at(-1)).toBe("stellan-1-lite");
});
it("continues delegating beyond five calls and still requires delegation for later writes", async () => {
  const code = vi.fn(async () => "code"); const report = vi.fn();
  const delegate = createDelegate({ totalBytes: 16 * GiB, noSwap: false, available: true, code }, report);
  for (let i = 0; i < 7; i++) { await delegate(request, new AbortController().signal); }
  expect(code).toHaveBeenCalledTimes(7);
  expect(report.mock.calls.flat().join(" ")).toContain("Code specialist call 7.");
  delegate.applied();
  expect(delegate.requiresDelegation({ ...request, function: { name: "write_file", arguments: "{}" } })).toBe(true);
});
it.each([8, 15.9])("falls back below 16 GB (%s GB)", async (amount) => {
  const code = vi.fn(async () => "code"); const delegate = createDelegate({ totalBytes: amount * GiB, noSwap: false, available: true, code }, vi.fn());
  expect(await delegate(request, new AbortController().signal)).toBe("Code specialist needs 16 GB RAM. Writing the code here instead.");
  expect(code).not.toHaveBeenCalled();
});
it("no-swap refuses delegation and lets Lite write", async () => {
  const code = vi.fn(async () => "code"); const delegate = createDelegate({ totalBytes: 16 * GiB, noSwap: true, available: true, code }, vi.fn());
  expect(await delegate(request, new AbortController().signal)).toContain("--no-swap");
  expect(code).not.toHaveBeenCalled();
  expect(delegate.requiresDelegation({ ...request, function: { name: "write_file", arguments: "{}" } })).toBe(false);
});

it("requires delegation before a new file and a larger or function edit", async () => {
  const delegate = createDelegate({ totalBytes: 16 * GiB, noSwap: false, available: true, code: async () => "code" }, vi.fn());
  const file: Call = { ...request, function: { name: "write_file", arguments: '{"path":"new.ts","content":"x"}' } };
  expect(delegate.requiresDelegation(file)).toBe(true);
  expect(delegate.requiresDelegation({ ...request, function: { name: "edit_file", arguments: JSON.stringify({ old: "x", new: "function newFunction() {}" }) } })).toBe(true);
  expect(delegate.requiresDelegation({ ...request, function: { name: "edit_file", arguments: JSON.stringify({ old: "x", new: Array(22).fill("line").join("\n") }) } })).toBe(true);
  await delegate(request, new AbortController().signal);
  expect(delegate.requiresDelegation(file)).toBe(false);
  delegate.applied(); expect(delegate.requiresDelegation(file)).toBe(true);
});

it("does not reload Lite after a cancelled delegation", async () => {
  const controller = new AbortController();
  const engine = { stop: vi.fn(async () => {}), start: vi.fn(async (_model: string) => {}) };
  const reason = new Error("Cancelled");
  await expect(codeWithSwap(engine, async () => { controller.abort(reason); throw reason; }, controller.signal, vi.fn())).rejects.toBe(reason);
  expect(engine.start.mock.calls.map(([model]) => model)).toEqual(["stellan-1-max"]);
  expect(engine.stop).toHaveBeenCalledTimes(2);
});
