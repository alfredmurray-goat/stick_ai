import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../src/sandbox/paths.js";
import { Tools, replaceUnique } from "../src/tools/index.js";
import { runAgent } from "../src/agent/index.js";
import { History } from "../src/agent/history.js";
import { ThinkingParser } from "../src/model/thinking.js";
import { Ollama } from "../src/model/ollama.js";
import { endpoint } from "../src/config/index.js";
import type { Call, Message, Model } from "../src/model/types.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "stick-")); roots.push(root);
  return Sandbox.create(root);
}
function call(name: string, args: object = {}): Call {
  return { id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}
describe("sandbox", () => {
  it("blocks traversal, absolute paths and reserved state", async () => {
    const box = await fixture();
    for (const path of ["../secret", "a/../../secret", "/etc/passwd", "a\\..\\secret", ".stick/history.jsonl"]) {
      await expect(box.path(path)).rejects.toThrow();
    }
    expect(await box.path("src/new.ts")).toBe(join(box.root, "src/new.ts"));
  });
  it("enforces one project session at a time", async () => {
    const history = new History(await fixture());
    const release = await history.lock();
    await expect(history.lock()).rejects.toThrow("locked");
    await release();
    await (await history.lock())();
  });
  it("blocks external and dangling symlinks in ancestor and leaf positions", async () => {
    const box = await fixture(); const outside = await fixture();
    await writeFile(join(outside.root, "secret"), "secret");
    await symlink(outside.root, join(box.root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await symlink(join(outside.root, "missing"), join(box.root, "dangling"));
    await expect(box.path("escape/secret")).rejects.toThrow("Symlinks");
    await expect(box.path("dangling")).rejects.toThrow("Symlinks");
  });
  it("never writes through a symlink", async () => {
    const box = await fixture(); const outside = await fixture();
    await writeFile(join(outside.root, "secret"), "unchanged");
    await symlink(join(outside.root, "secret"), join(box.root, "link"));
    const tools = new Tools(box, async () => true);
    await expect(tools.execute(call("write_file", { path: "link", content: "bad" }), new AbortController().signal)).rejects.toThrow();
    expect(await readFile(join(outside.root, "secret"), "utf8")).toBe("unchanged");
  });
});
describe("edits and approval", () => {
  it("replaces precisely one match including literal replacement tokens", () => {
    expect(replaceUnique("a hello z", "hello", "$&")).toBe("a $& z");
    for (const [text, old] of [["aaa", "aa"], ["x x", "x"], ["abc", "z"], ["abc", ""]]) {
      expect(() => replaceUnique(text!, old!, "new")).toThrow("exactly one");
    }
  });
  it("applies an approved unique edit and refuses duplicate edits", async () => {
    const box = await fixture(); await writeFile(join(box.root, "a"), "old old");
    const tools = new Tools(box, async () => true);
    await expect(tools.execute(call("edit_file", { path: "a", old: "old", new: "new" }), new AbortController().signal)).rejects.toThrow();
    await writeFile(join(box.root, "a"), "old");
    await tools.execute(call("edit_file", { path: "a", old: "old", new: "new" }), new AbortController().signal);
    expect(await readFile(join(box.root, "a"), "utf8")).toBe("new");
  });
  it("denial prevents mutation", async () => {
    const box = await fixture(); const tools = new Tools(box, async () => false);
    expect(await tools.execute(call("write_file", { path: "a", content: "bad" }), new AbortController().signal)).toBe("Denied by user");
    await expect(readFile(join(box.root, "a"))).rejects.toThrow();
  });
});
describe("agent", () => {
  function setup(model: Model, maxSteps = 20) {
    return { task: "fix", messages: [] as Message[], model, tools: { execute: vi.fn(async () => "result") }, maxSteps, signal: new AbortController().signal, emit: vi.fn(), log: vi.fn(), save: vi.fn(async () => {}) };
  }
  it("plans, executes, supplies results and finishes", async () => {
    const model: Model = { complete: vi.fn().mockResolvedValueOnce({ content: 'Plan<tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>', calls: [] }).mockResolvedValueOnce({ content: "<done>Done</done>", calls: [] }) };
    const options = setup(model);
    expect(await runAgent(options)).toBe("finished");
    expect(options.tools.execute).toHaveBeenCalledOnce();
    expect(options.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(vi.mocked(model.complete).mock.calls[1]![0].some((m) => m.role === "user" && m.content === "<tool_result>result</tool_result>")).toBe(true);
  });
  it("stops at the configured limit", async () => {
    const model: Model = { complete: vi.fn(async () => ({ content: '<tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>', calls: [] })) };
    const options = setup(model, 2);
    expect(await runAgent(options)).toBe("limit"); expect(model.complete).toHaveBeenCalledTimes(2);
  });
  it("returns tool errors to the model", async () => {
    const model: Model = { complete: vi.fn().mockResolvedValueOnce({ content: '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>', calls: [] }).mockResolvedValueOnce({ content: "<done>Done</done>", calls: [] }) };
    const options = setup(model); options.tools.execute.mockRejectedValue(new Error("bad tool"));
    await runAgent(options);
    expect(options.messages.find((m) => m.content.startsWith("<tool_result>"))?.content).toContain("bad tool");
  });
  it("cancellation prevents tool execution", async () => {
    const controller = new AbortController();
    const model: Model = { complete: vi.fn(async () => { controller.abort(); return { content: "", calls: [call("write_file")] }; }) };
    const options = { ...setup(model), signal: controller.signal };
    await expect(runAgent(options)).rejects.toThrow(); expect(options.tools.execute).not.toHaveBeenCalled();
  });
});
it("resumes persisted batches and repairs only a truncated final line", async () => {
  const box = await fixture(); const history = new History(box);
  await history.append([{ role: "user", content: "first" }]);
  const file = join(box.root, ".stick/history.jsonl");
  await writeFile(file, (await readFile(file, "utf8")) + "{broken");
  expect(await history.load()).toEqual([{ role: "user", content: "first" }]);
  await history.append([{ role: "assistant", content: "second" }]);
  expect(await history.load()).toHaveLength(2);
  await history.clear(); expect(await history.load()).toEqual([]);
});
it("separates thinking tags across arbitrary chunks", () => {
  const parts: [string, boolean][] = []; const parser = new ThinkingParser((text, thinking) => parts.push([text, thinking]));
  for (const character of "<think>reason</think>answer") { parser.push(character); } parser.finish();
  expect(parts.filter(([, thinking]) => thinking).map(([text]) => text).join("")).toBe("reason");
  expect(parts.filter(([, thinking]) => !thinking).map(([text]) => text).join("")).toBe("answer");
});
it("refuses remote endpoints and credentials unless explicitly permitted", () => {
  expect(() => endpoint("http://example.com", false)).toThrow("Remote");
  expect(() => endpoint("http://user:pass@localhost", true)).toThrow();
  expect(endpoint("http://127.0.0.1:11434/v1", false)).toContain("/v1/chat/completions");
  expect(endpoint("https://example.com", true)).toContain("example.com");
});
it("assembles a fragmented tagged tool call", async () => {
  const chunks = [
    { choices: [{ delta: { content: '<think>x</think>plan<tool_call>{"name":"read_file","arguments":' } }] },
    { choices: [{ delta: { content: '{"path":"a"}}</tool_call>' } }] }
  ];
  const wire = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    for (const char of wire) { controller.enqueue(new TextEncoder().encode(char)); } controller.close();
  } }))));
  const reply = await new Ollama("stellan-1-lite", "http://localhost:11434").complete([], new AbortController().signal, () => {});
  expect(reply.calls[0]?.function).toEqual({ name: "read_file", arguments: '{"path":"a"}' });
});
it("refuses truncated streams before tools execute", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')));
  await expect(new Ollama("stellan-1-lite", "http://localhost:11434").complete([], new AbortController().signal, () => {})).rejects.toThrow("Truncated");
});
