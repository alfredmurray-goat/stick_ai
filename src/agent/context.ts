import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import type { Sandbox } from "../sandbox/paths.js";
import type { Message } from "../model/types.js";

export interface ContextSource { list(signal: AbortSignal): Promise<string[]>; read(path: string, signal: AbortSignal): Promise<string> }
export function contextLimit(value = process.env.STICK_CONTEXT_MAX_BYTES): number {
  const bytes = value === undefined ? 16384 : Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 256 || bytes > 1048576) { throw new Error("STICK_CONTEXT_MAX_BYTES must be 256..1048576"); }
  return bytes;
}
export function clipUtf8(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) { return text; }
  let used = 0; let result = "";
  for (const character of text) { const bytes = Buffer.byteLength(character); if (used + bytes > limit) { break; } result += character; used += bytes; }
  return result;
}
function mentions(task: string, name: string): boolean {
  let from = 0;
  const lower = task.toLowerCase().replaceAll("./", ""); const target = name.toLowerCase();
  while (from < lower.length) {
    const index = lower.indexOf(target, from); if (index < 0) { return false; }
    const before = lower[index - 1] ?? " "; const after = lower[index + target.length] ?? " ";
    if (!/[a-z0-9_./\\-]/i.test(before) && !/[a-z0-9_./\\-]/i.test(after)) { return true; }
    from = index + target.length;
  }
  return false;
}
export async function buildTaskContext(task: string, source: ContextSource, limit = contextLimit(), signal = new AbortController().signal): Promise<string> {
  const files = (await source.list(signal)).sort();
  const basenames = new Map<string, number>();
  for (const file of files) { const name = file.split(/[\\/]/).at(-1)!.toLowerCase(); basenames.set(name, (basenames.get(name) ?? 0) + 1); }
  let result = clipUtf8(`Project file list:\n${files.join("\n") || "(No files yet)"}\n`, Math.min(4096, Math.floor(limit / 3)));
  for (const file of files) {
    signal.throwIfAborted();
    const name = file.split(/[\\/]/).at(-1)!;
    if (!mentions(task, file) && !(basenames.get(name.toLowerCase()) === 1 && mentions(task, name))) { continue; }
    const remaining = limit - Buffer.byteLength(result);
    if (remaining < 64) { break; }
    try { result += clipUtf8(`\nNamed file: ${file}\n${await source.read(file, signal)}\n`, remaining); }
    catch { result += clipUtf8(`\nNamed file ${file} is unavailable; inspect it with a file tool if needed.\n`, remaining); }
  }
  return result;
}
export function projectContext(box: Sandbox): ContextSource {
  return {
    async list(signal) {
      const files: string[] = []; let scanned = 0;
      const walk = async (path: string): Promise<void> => {
        for (const entry of await readdir(await box.path(path), { withFileTypes: true })) {
          signal.throwIfAborted(); if (++scanned > 5000 || files.length >= 1000) { return; }
          if ([".stick", ".git", "node_modules", "dist"].includes(entry.name) || entry.isSymbolicLink()) { continue; }
          const child = join(path, entry.name);
          if (entry.isDirectory()) { await walk(child); } else if (entry.isFile()) { files.push(child.replaceAll("\\", "/")); }
        }
      };
      await walk("."); return files;
    },
    async read(path, signal) {
      signal.throwIfAborted(); const file = await open(await box.path(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) { throw new Error("Unsafe context file"); }
        const buffer = Buffer.alloc(Math.min(info.size, 1048576)); const result = await file.read(buffer); signal.throwIfAborted(); return buffer.subarray(0, result.bytesRead).toString("utf8");
      } finally { await file.close(); }
    }
  };
}
export function boundedToolHistory(messages: Message[], limit = contextLimit()): Message[] {
  let remaining = limit;
  return [...messages].reverse().map((message) => {
    if (message.role === "system" || message.role === "user" && !message.content.startsWith("<tool_result>")) { return message; }
    const bytes = Buffer.byteLength(message.content);
    if (bytes <= remaining) { remaining -= bytes; return message; }
    const payload = clipUtf8(message.content, Math.max(0, remaining - 100)); remaining = 0;
    return { ...message, content: `${payload}\n[Older context omitted to keep this request small; read focused files if needed.]` };
  }).reverse();
}
