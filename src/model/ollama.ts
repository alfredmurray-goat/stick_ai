import { stellanGrammar } from "./grammar.js";
import { CodeThinkingStream } from "./thinking.js";
import { IdleWatchdog } from "./idle.js";
import { boundedToolHistory } from "../agent/context.js";
import { endpoint } from "../config/index.js";
import { assertModelAllowed, ramStatus, type RamStatus } from "../config/models.js";
import { modelMessages, parseStep, TaggedStream } from "./protocol.js";
import { errorText, type Message, type Model, type Reply } from "./types.js";

export class Ollama implements Model {
  private url: string;
  constructor(private model: string, baseUrl: string, remote = false, ram: RamStatus = ramStatus(), private options: { apiKey?: string; specialist?: boolean; maxTokens?: number } = {}) {
    assertModelAllowed(model, ram); this.url = endpoint(baseUrl, remote);
  }
  async complete(messages: Message[], signal: AbortSignal, emit: (text: string, thinking: boolean) => void): Promise<Reply> {
    const idle = new IdleWatchdog();
    try {
      let response: Response;
      const body = JSON.stringify({ model: this.model, messages: modelMessages(boundedToolHistory(messages)), stream: true, ...(this.model === "stellan-1-lite" && this.options.apiKey && !this.options.specialist ? { grammar: stellanGrammar, temperature: 0.2, cache_prompt: false } : {}), ...(this.options.maxTokens ? { max_tokens: this.options.maxTokens } : {}) });
      try {
        response = await fetch(this.url, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
          body,
          signal: AbortSignal.any([signal, idle.signal])
        });
      } catch (error) {
        if (signal.aborted) { throw signal.reason; }
        if (idle.signal.aborted) { throw idle.signal.reason; }
        throw new Error(`Cannot reach model. Start Ollama with 'ollama serve' and install '${this.model}'. ${errorText(error)}`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Ollama HTTP ${response.status}; check model name and local Ollama configuration`);
      }
      if (!response.body) { throw new Error("Empty model stream"); }
      let buffer = "";
      let size = 0;
      let done = false;
      let finished = false;
      const parser = new TaggedStream(emit);
      const code = new CodeThinkingStream(emit);
      const consume = (event: string): void => {
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) { return; }
        if (data === "[DONE]") { done = true; return; }
        const chunk = JSON.parse(data);
        if (chunk.error) { throw new Error(`Stream error: ${JSON.stringify(chunk.error)}`); }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) {
          if (!["stop", "length", "tool_calls"].includes(choice.finish_reason)) { throw new Error(`Incomplete model response: ${choice.finish_reason}`); }
          finished = true;
        }
        const delta = choice?.delta;
        if (!delta) { return; }
        if (typeof delta.reasoning === "string") { emit(delta.reasoning, true); }
        if (delta.tool_calls?.length) { throw new Error("Native tool calls are unsupported; Stellan must write <tool_call> JSON in its text response"); }
        if (typeof delta.content === "string") {
          if (this.options.specialist) { code.push(delta.content); } else { parser.push(delta.content); }
        }
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) { break; }
          idle.touch(part.value.byteLength);
          size += part.value.byteLength;
          if (size > 4000000) { throw new Error("Model response exceeds 4 MB"); }
          buffer += decoder.decode(part.value, { stream: true }).replaceAll("\r", "");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            consume(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            if (parser.complete) { break; }
          }
          if (done || parser.complete) { break; }
        }
        if (!parser.complete && buffer.trim()) { consume(buffer); }
        if (!parser.complete && !done && !finished) { throw new Error("Truncated stream; no tools executed"); }
        parser.finish();
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (this.options.specialist) { code.finish(); return { content: code.code, calls: [] }; }
      const parsed = parseStep(parser.content);
      return { content: parsed.content, calls: parsed.step.kind === "call" ? [parsed.step.call] : [], summaryStreamed: parsed.step.kind === "done" };
    } catch (error) { if (signal.aborted) { throw signal.reason; } if (idle.signal.aborted) { throw idle.signal.reason; } throw error; } finally { idle.dispose(); }
  }
}
