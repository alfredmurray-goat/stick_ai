import { afterEach, expect, it, vi } from "vitest";
import { IdleWatchdog, idleSeconds, ModelIdleError } from "../src/model/idle.js";
import { TaggedStream } from "../src/model/protocol.js";
import { CodeThinkingStream } from "../src/model/thinking.js";
import { buildTaskContext, boundedToolHistory, contextLimit } from "../src/agent/context.js";
import { ProgressTracker } from "../src/portable/progress.js";
import { friendlyError } from "../src/portable/errors.js";
import { Ollama } from "../src/model/ollama.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("aborts only after the full configured byte inactivity interval", () => {
  vi.useFakeTimers(); const idle = new IdleWatchdog(300);
  vi.advanceTimersByTime(299999); expect(idle.signal.aborted).toBe(false);
  idle.touch(1); vi.advanceTimersByTime(299999); expect(idle.signal.aborted).toBe(false);
  idle.touch(0); vi.advanceTimersByTime(1); expect(idle.signal.reason).toBeInstanceOf(ModelIdleError); idle.dispose();
});
it("removes the timer when a request finishes and validates configuration", () => {
  vi.useFakeTimers(); const idle = new IdleWatchdog(1); idle.dispose(); vi.advanceTimersByTime(2000); expect(idle.signal.aborted).toBe(false);
  expect(idleSeconds()).toBe(300); expect(idleSeconds("17")).toBe(17); expect(() => idleSeconds("no")).toThrow();
});
it("counts SSE heartbeat bytes, allowing a response beyond the old five minute deadline", async () => {
  vi.useFakeTimers(); vi.stubEnv("STICK_IDLE_TIMEOUT_SECONDS", "300");
  let controller: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(stream) {
    controller = stream;
    init.signal?.addEventListener("abort", () => stream.error(init.signal?.reason));
  } }))));
  const output: string[] = [];
  const request = new Ollama("stellan-1-lite", "http://localhost:11434").complete([], new AbortController().signal, (value) => output.push(value));
  await vi.advanceTimersByTimeAsync(200000); controller!.enqueue(new TextEncoder().encode(": keepalive\n\n")); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(200000); controller!.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"<done>Ready</done>"}}]}\n\n')); await vi.advanceTimersByTimeAsync(0);
  expect((await request).content).toBe("<done>Ready</done>"); expect(output.join("")).toBe("Ready");
});
it("aborts a genuinely idle fetch without waiting for a complete SSE event", async () => {
  vi.useFakeTimers(); vi.stubEnv("STICK_IDLE_TIMEOUT_SECONDS", "1");
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))));
  const result = new Ollama("stellan-1-lite", "http://localhost:11434").complete([], new AbortController().signal, () => {}).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(999); expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1); expect(await result).toBeInstanceOf(ModelIdleError);
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
it("offers a faster setting after two idle failures and hides technical errors", () => {
  expect(friendlyError(new ModelIdleError(), 1).action).toBe("Retry"); expect(friendlyError(new ModelIdleError(), 2).action).toBe("Switch to a faster setting");
  expect(JSON.stringify(friendlyError(new Error("secret path /tmp/port:8080")))).not.toContain("8080");
});
