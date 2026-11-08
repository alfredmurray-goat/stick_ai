import { toolNames } from "../tools/schema.js";
import type { Call, Message } from "./types.js";

export type Step = { kind: "call"; call: Call } | { kind: "done"; summary: string } | { kind: "error"; error: string };
export class TaggedStream {
  content = "";
  complete = false;
  private pending = "";
  private mode: "text" | "think" | "tool" | "done" = "text";
  private resume: "text" | "done" = "text";
  constructor(private emit: (text: string, thinking: boolean) => void) {}
  push(text: string): void {
    if (this.complete) { return; }
    this.pending += text;
    while (this.pending && !this.complete) {
      const tags = this.mode === "text" ? ["<think>", "<tool_call>", "<done>"] : this.mode === "think" ? ["</think>"] : this.mode === "tool" ? ["</tool_call>"] : ["<think>", "</done>"];
      const found = tags.map((tag) => ({ tag, index: this.pending.indexOf(tag) })).filter((item) => item.index >= 0).sort((a, b) => a.index - b.index)[0];
      if (found) {
        this.output(this.pending.slice(0, found.index));
        this.content += found.tag;
        this.pending = this.pending.slice(found.index + found.tag.length);
        if (found.tag === "<think>") { this.resume = this.mode === "done" ? "done" : "text"; this.mode = "think"; }
        else if (found.tag === "</think>") { this.mode = this.resume; }
        else if (found.tag === "<tool_call>") { this.mode = "tool"; }
        else if (found.tag === "<done>") { this.mode = "done"; }
        else { this.complete = true; this.pending = ""; }
      } else {
        let keep = Math.min(Math.max(...tags.map((tag) => tag.length)) - 1, this.pending.length);
        while (keep && !tags.some((tag) => tag.startsWith(this.pending.slice(-keep)))) { keep--; }
        const length = this.pending.length - keep;
        this.output(this.pending.slice(0, length)); this.pending = this.pending.slice(length); break;
      }
    }
  }
  private output(text: string): void {
    this.content += text;
    if (text && (this.mode === "text" || this.mode === "think" || this.mode === "done")) { this.emit(text, this.mode === "think"); }
  }
  finish(): void {
    if (!this.complete) { this.output(this.pending); this.pending = ""; }
  }
}
export function parseStep(content: string): { content: string; step: Step } {
  const parser = new TaggedStream(() => {});
  parser.push(content); parser.finish();
  const text = parser.content;
  let tool = "";
  let summary = "";
  let mode: "text" | "think" | "tool" | "done" = "text";
  let resume: "text" | "done" = "text";
  for (let index = 0; index < text.length;) {
    const token = mode === "think" ? "</think>" : mode === "tool" ? "</tool_call>" : mode === "done" ? "</done>" : "";
    if (token && text.startsWith(token, index)) {
      index += token.length;
      if (mode === "think") { mode = resume; continue; }
      if (mode === "done") { return { content: text, step: { kind: "done", summary } }; }
      try {
        const value: unknown = JSON.parse(tool);
        if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("Tool call must be a JSON object"); }
        const data = value as Record<string, unknown>;
        if (typeof data.name !== "string" || !toolNames.includes(data.name)) { throw new Error(`Unknown tool name: ${String(data.name)}. Allowed: ${toolNames.join(", ")}`); }
        if (!data.arguments || typeof data.arguments !== "object" || Array.isArray(data.arguments)) { throw new Error("Tool arguments must be a JSON object"); }
        return { content: text, step: { kind: "call", call: { id: "tagged-call", type: "function", function: { name: data.name, arguments: JSON.stringify(data.arguments) } } } };
      } catch (error) { return { content: text, step: { kind: "error", error: `Invalid tool call: ${error instanceof Error ? error.message : String(error)}` } }; }
    }
    if ((mode === "text" || mode === "done") && text.startsWith("<think>", index)) { resume = mode; mode = "think"; index += 7; continue; }
    if (mode === "text" && text.startsWith("<tool_call>", index)) { mode = "tool"; index += 11; continue; }
    if (mode === "text" && text.startsWith("<done>", index)) { mode = "done"; index += 6; continue; }
    if (mode === "tool") { tool += text[index]; }
    else if (mode === "done") { summary += text[index]; }
    index++;
  }
  return { content: text, step: { kind: "error", error: "Expected one complete <tool_call> JSON block or a <done> summary. Please use the required protocol." } };
}
export function toolResult(result: string): string { return `<tool_result>${result}</tool_result>`; }

export function modelMessages(messages: Message[]): Pick<Message, "role" | "content">[] {
  return messages.map((message) => {
    if (message.role === "tool") { return { role: "user", content: toolResult(message.content) }; }
    const legacy = message.tool_calls?.[0];
    if (!legacy) { return { role: message.role, content: message.content }; }
    let args: unknown;
    try { args = JSON.parse(legacy.function.arguments); }
    catch { throw new Error("Cannot resume malformed native tool history; use /clear or move .stick/history.jsonl aside"); }
    return { role: message.role, content: `${message.content}\n<tool_call>${JSON.stringify({ name: legacy.function.name, arguments: args })}</tool_call>` };
  });
}
