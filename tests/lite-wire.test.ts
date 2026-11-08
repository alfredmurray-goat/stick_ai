import { afterEach, expect, it, vi } from "vitest";
import { Ollama } from "../src/model/ollama.js";
import { ramStatus } from "../src/config/models.js";
import { stellanGrammar } from "../src/model/grammar.js";
import { toolNames } from "../src/tools/schema.js";
afterEach(() => vi.unstubAllGlobals());
it("keeps managed Lite on the text training protocol with constrained tags and a fresh recurrent prompt", async () => {
  const fetch = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"<done>Ready</done>"},"finish_reason":"stop"}]}\n\n'));
  vi.stubGlobal("fetch", fetch);
  await new Ollama("stellan-1-lite", "http://127.0.0.1:8080", false, ramStatus(8 * 1024 ** 3), { apiKey: "local-test-key" }).complete([], new AbortController().signal, () => {});
  const body = JSON.parse(String((fetch.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
  expect(body.grammar).toBe(stellanGrammar); expect(body.cache_prompt).toBe(false); expect(body.temperature).toBe(0.2);
  expect(body.tools).toBeUndefined(); expect(body.tool_choice).toBeUndefined();
  for (const name of toolNames) { expect(stellanGrammar).toContain(name); }
});
it("preserves compatibility with Ollama without sending llama.cpp-specific grammar settings", async () => {
  const fetch = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"<done>Ready</done>"},"finish_reason":"stop"}]}\n\n'));
  vi.stubGlobal("fetch", fetch);
  await new Ollama("stellan-1-lite", "http://localhost:11434").complete([], new AbortController().signal, () => {});
  const body = JSON.parse(String((fetch.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
  expect(body.grammar).toBeUndefined(); expect(body.cache_prompt).toBeUndefined();
});
