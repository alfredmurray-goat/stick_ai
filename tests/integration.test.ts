import { expect, it } from "vitest";
import { Ollama } from "../src/model/ollama.js";
import { endpoint } from "../src/config/index.js";

it.skipIf(process.env.STICK_INTEGRATION !== "1")("uses a live local Ollama tool call", async (context) => {
  const base = process.env.STICK_BASE_URL ?? "http://localhost:11434";
  const model = process.env.STICK_MODEL ?? "stellan-1-lite";
  const client = new Ollama(model, base);
  const url = endpoint(base, false);
  try {
    const probe = await fetch(url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply OK" }], stream: false }), signal: AbortSignal.timeout(60000) });
    await probe.body?.cancel();
    expect(probe.ok, `Model probe HTTP ${probe.status}`).toBe(true);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) { context.skip(); return; }
    throw error;
  }
  const response = await client.complete([{ role: "user", content: 'Reply only with <tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>. Stop after the closing tag.' }], new AbortController().signal, () => {});
  expect(response.calls.some((call) => call.function.name === "list_dir")).toBe(true);
}, 360000);
