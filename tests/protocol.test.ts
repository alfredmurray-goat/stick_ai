import { afterEach, expect, it, vi } from "vitest";
import { modelMessages, parseStep, TaggedStream } from "../src/model/protocol.js";
import { runAgent } from "../src/agent/index.js";
import { Ollama } from "../src/model/ollama.js";
import { Tools } from "../src/tools/index.js";
import type { Call, Message, Model } from "../src/model/types.js";
import type { Sandbox } from "../src/sandbox/paths.js";

afterEach(() => { vi.unstubAllGlobals(); });
const tagged = (name = "list_dir"): string => `<tool_call>${JSON.stringify({ name, arguments: { path: "." } })}</tool_call>`;
function setup(responses: string[]) {
  const model: Model = { complete: vi.fn(async () => ({ content: responses.shift() ?? "<done>Done</done>", calls: [] })) };
  return { task: "work", messages: [] as Message[], model, tools: { execute: vi.fn(async (_call: Call, _signal: AbortSignal) => "result") }, maxSteps: 5, signal: new AbortController().signal, emit: vi.fn(), log: vi.fn(), save: vi.fn(async () => {}) };
}
it("only executes the first call and waits for its result before continuing", async () => {
  const options = setup([tagged() + tagged("run_shell") + "<done>Too early</done>", "<done>Actual summary</done>"]);
  await runAgent(options);
  expect(options.tools.execute).toHaveBeenCalledOnce();
  expect(options.tools.execute.mock.calls[0]?.[0].function.name).toBe("list_dir");
  expect(options.messages[1]?.content).toBe(tagged());
  expect(options.messages[2]).toEqual({ role: "user", content: "<tool_result>result</tool_result>" });
  expect(options.emit).toHaveBeenCalledWith("Actual summary", false);
});
it("rejects unknown tool names, reports them to the user and returns a recovery result", async () => {
  const options = setup([tagged("delete_everything"), "<done>Recovered</done>"]);
  await runAgent(options);
  expect(options.tools.execute).not.toHaveBeenCalled();
  expect(options.log.mock.calls.flat().join(" ")).toContain("Unknown tool name: delete_everything");
  expect(options.messages[2]?.content).toMatch(/^<tool_result>Error: Invalid tool call: Unknown tool name:/);
});
it("independently blocks unknown tool names in the executor", async () => {
  const approve = vi.fn(async () => true);
  const tools = new Tools({} as Sandbox, approve);
  await expect(tools.execute({ id: "x", type: "function", function: { name: "unknown", arguments: "{}" } }, new AbortController().signal)).rejects.toThrow("Unknown tool name");
  expect(approve).not.toHaveBeenCalled();
});
it("recovers from malformed JSON rather than crashing or executing anything", async () => {
  const options = setup(["<tool_call>{bad JSON}</tool_call>", tagged(), "<done>Fixed</done>"]);
  expect(await runAgent(options)).toBe("finished");
  expect(options.tools.execute).toHaveBeenCalledOnce();
  expect(options.messages[2]?.content).toContain("<tool_result>Error: Invalid tool call:");
});
it("requires done tags rather than treating an empty call list as completion", async () => {
  const options = setup(["No tags", "<done>Finished</done>"]);
  expect(await runAgent(options)).toBe("finished");
  expect(options.model.complete).toHaveBeenCalledTimes(2);
  expect(options.messages[2]?.content).toContain("Expected one complete");
});
it("ignores calls inside thinking and preserves literal thinking tags inside JSON strings", () => {
  const parsed = parseStep(`<think>${tagged("run_shell")}</think>${tagged()}`);
  expect(parsed.step.kind === "call" && parsed.step.call.function.name).toBe("list_dir");
  const literal = parseStep('<tool_call>{"name":"write_file","arguments":{"path":"a","content":"<think>literal</think>"}}</tool_call>');
  expect(literal.step.kind === "call" && JSON.parse(literal.step.call.function.arguments).content).toBe("<think>literal</think>");
});
it("handles every tag split, dims thought content and hides protocol tags", () => {
  const output: [string, boolean][] = [];
  const stream = new TaggedStream((text, thinking) => output.push([text, thinking]));
  for (const char of `<think>reason</think>Plan${tagged()}ignored`) { stream.push(char); }
  stream.finish();
  expect(stream.complete).toBe(true);
  expect(output.filter(([, thinking]) => thinking).map(([text]) => text).join("")).toBe("reason");
  expect(output.filter(([, thinking]) => !thinking).map(([text]) => text).join("")).toBe("Plan");
  expect(stream.content).not.toContain("ignored");
});
it("prints only the summary inside done, stripping any thought block", async () => {
  const options = setup(["<done>Summary<think>private thought</think> here</done>ignored"]);
  await runAgent(options);
  expect(options.emit).toHaveBeenCalledWith("Summary here", false);
});
it("cancels the open stream after its first complete block and sends no native tool fields", async () => {
  let cancelled = false;
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: tagged() + tagged("run_shell") } }] })}\n\n`));
  }, cancel() { cancelled = true; } })));
  vi.stubGlobal("fetch", fetch);
  const response = await new Ollama("stellan-1-lite", "http://localhost:11434").complete([{ role: "user", content: "work" }], new AbortController().signal, () => {});
  expect(response.content).toBe(tagged()); expect(response.calls).toHaveLength(1); expect(cancelled).toBe(true);
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(body.tools).toBeUndefined(); expect(body.tool_choice).toBeUndefined(); expect(body.stream).toBe(true);
});

it("converts legacy native history without sending tool roles or IDs", () => {
  const messages = modelMessages([
    { role: "assistant", content: "Plan", tool_calls: [{ id: "old", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } }] },
    { role: "tool", content: "files", tool_call_id: "old" }
  ]);
  expect(messages[0]).toEqual({ role: "assistant", content: `Plan\n${tagged()}` });
  expect(messages[1]).toEqual({ role: "user", content: "<tool_result>files</tool_result>" });
  expect(JSON.stringify(messages)).not.toContain("tool_call_id");
});

it("returns an error result and recovers when malformed JSON reaches a model token limit", async () => {
  const contents = ["<tool_call>{bad JSON", "<done>Recovered</done>"];
  vi.stubGlobal("fetch", vi.fn(async () => {
    const content = contents.shift();
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: contents.length ? "length" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const options = { ...setup([]), model: new Ollama("stellan-1-lite", "http://localhost:11434") };
  expect(await runAgent(options)).toBe("finished");
  expect(options.messages[2]?.content).toMatch(/^<tool_result>Error:/);
  expect(options.tools.execute).not.toHaveBeenCalled();
});
