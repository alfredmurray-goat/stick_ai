import { afterEach, expect, it, vi } from "vitest";
import { TaggedStream } from "../src/model/protocol.js";
import { CodeThinkingStream } from "../src/model/thinking.js";
import { buildTaskContext, boundedToolHistory, contextLimit } from "../src/agent/context.js";
import { ProgressTracker } from "../src/portable/progress.js";
import { friendlyError } from "../src/portable/errors.js";
import { Ollama } from "../src/model/ollama.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("waits through long silent streams even with a legacy inactivity setting", async () => {
  vi.useFakeTimers(); vi.stubEnv("STICK_IDLE_TIMEOUT_SECONDS", "1");
  let stream: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
    stream = controller;
    init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
  } }))));
  const output: string[] = []; const controller = new AbortController();
  const result = new Ollama("stellan-1-lite", "http://localhost:11434").complete([], controller.signal, (value) => output.push(value));
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(controller.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
  stream!.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"<done>Ready</done>"}}]}\n\n'));
  expect((await result).content).toBe("<done>Ready</done>"); expect(output.join("")).toBe("Ready");
});
it("allows the user to cancel a silent model request", async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))));
  const result = new Ollama("stellan-1-lite", "http://localhost:11434").complete([], controller.signal, () => {}).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  controller.abort(); expect(await result).toBe(controller.signal.reason);
});
it("streams thought and summary fragments before the closing done tag", () => {
  const thought: string[] = []; const answer: string[] = [];
  const stream = new TaggedStream((text, thinking) => (thinking ? thought : answer).push(text));
  for (const char of "<think>Considering files</think><done>Here is the answer") { stream.push(char); }
  expect(thought.join("")).toBe("Considering files"); expect(answer.join("")).toContain("Here is");
  stream.push("</done>"); stream.finish(); expect(answer.join("")).toBe("Here is the answer");
});
it("streams specialist thinking separately while preserving tags inside generated code", () => {
  const output: [string, boolean][] = []; const stream = new CodeThinkingStream((text, thinking) => output.push([text, thinking]));
  for (const char of '<think>Plan carefully</think>const x = "<tool_call>literal</tool_call>";') { stream.push(char); }
  stream.finish(); expect(stream.code).toBe('const x = "<tool_call>literal</tool_call>";');
  expect(output.filter((item) => item[1]).map((item) => item[0]).join("")).toBe("Plan carefully");
});
it("uses human progress labels and shows elapsed and reassurance at the correct times", () => {
  vi.useFakeTimers(); const progress = new ProgressTracker(); progress.begin("thinking");
  expect(progress.view().elapsedSeconds).toBeNull(); expect(progress.view({ slots: [{ processing_prompt: true }] }).message).toBe("Reading your project...");
  vi.advanceTimersByTime(10000); expect(progress.view().elapsedSeconds).toBe(10); expect(progress.view().reassurance).toBeNull();
  vi.advanceTimersByTime(50000); expect(progress.view().reassurance).toBe("Still working. Large models on this computer can take a few minutes.");
  progress.output(); expect(progress.view().reassurance).toBeNull(); expect(progress.view().message).toBe("Thinking...");
});
it("reads only named files and never scans every file's contents", async () => {
  const source = { list: vi.fn(async () => ["src/main.ts", "src/private.ts", "README.md"]), read: vi.fn(async () => "selected file text") };
  const result = await buildTaskContext("Change main.ts", source);
  expect(source.read).toHaveBeenCalledExactlyOnceWith("src/main.ts", expect.any(AbortSignal));
  expect(result).toContain("src/private.ts"); expect(result).toContain("selected file text");
  source.read.mockClear(); await buildTaskContext("Explain this project", source); expect(source.read).not.toHaveBeenCalled();
});
it("does not guess ambiguous filenames and respects UTF-8 context limits", async () => {
  const source = { list: async () => ["a/index.ts", "b/index.ts"], read: vi.fn(async () => "😀".repeat(1000)) };
  await buildTaskContext("edit index.ts", source); expect(source.read).not.toHaveBeenCalled();
  const result = await buildTaskContext("edit a/index.ts", source, 256); expect(Buffer.byteLength(result)).toBeLessThanOrEqual(256); expect(result).not.toContain("�");
  expect(contextLimit()).toBe(16384); expect(() => contextLimit("-1")).toThrow();
});
it("bounds sent tool context without mutating retained conversation history", () => {
  const history = [{ role: "user" as const, content: "Task" }, { role: "user" as const, content: `<tool_result>${"x".repeat(5000)}</tool_result>` }];
  const sent = boundedToolHistory(history, 256); expect(sent[1]!.content.length).toBeLessThan(300); expect(history[1]!.content.length).toBeGreaterThan(5000);
});
it("hides technical errors", () => {
  expect(JSON.stringify(friendlyError(new Error("secret path /tmp/port:8080")))).not.toContain("8080");
});
it.each(['reasoning','reasoning_content','thinking'])('streams %s before the final answer arrives',async(field)=>{
 let stream!:ReadableStreamDefaultController<Uint8Array>;vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){stream=controller;}}))));
 const output:[string,boolean][]=[];const promise=new Ollama('stellan-1-lite','http://localhost:11434').complete([],new AbortController().signal,(text,thinking)=>output.push([text,thinking]));
 await Promise.resolve();await Promise.resolve();
 stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{reasoning:'',[field]:'Inspecting the project'}}]})+'\n\n'));
 await vi.waitFor(()=>expect(output).toContainEqual(['Inspecting the project',true]));
 stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'<done>Finished</done>'},finish_reason:'stop'}]})+'\n\n'));stream.close();
 expect((await promise).content).toBe('<done>Finished</done>');expect(output.filter(([,thinking])=>!thinking).map(([text])=>text).join('')).toBe('Finished');
});
