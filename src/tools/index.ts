import { readdir, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { Sandbox } from "../sandbox/paths.js";
import { runShell } from "../sandbox/shell.js";
import { detectBackend, shellApproval, type Backend } from "../sandbox/backends.js";
import { toolNames } from "./schema.js";
import type { Call } from "../model/types.js";

export function replaceUnique(content: string, old: string, replacement: string): string {
  const index = content.indexOf(old);
  if (!old || index < 0 || content.indexOf(old, index + 1) >= 0) { throw new Error("edit_file requires exactly one nonempty match"); }
  return content.slice(0, index) + replacement + content.slice(index + old.length);
}
export class Tools {
  constructor(private box: Sandbox, private approve: (description: string, signal: AbortSignal) => Promise<boolean>, private backend?: Backend, private warn: (message: string) => void = console.error) {}
  private async read(path: string): Promise<string> {
    const file = await open(await this.box.path(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1048576) { throw new Error("Read requires a regular file under 1 MiB without hard links"); }
      return new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile());
    } finally { await file.close(); }
  }
  async execute(call: Call, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!toolNames.includes(call.function.name)) { throw new Error(`Unknown tool name: ${call.function.name}`); }
    const parsed: unknown = JSON.parse(call.function.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { throw new Error("Tool arguments must be an object"); }
    const args = parsed as Record<string, unknown>;
    const get = (key: string): string => {
      if (typeof args[key] !== "string") { throw new Error(`Missing string argument: ${key}`); }
      return args[key];
    };
    const name = call.function.name;
    if (name === "run_shell") {
      const backend = this.backend ?? await detectBackend(this.box);
      const command = get("command");
      if (backend.warning) { this.warn(backend.warning); }
      if (!await this.approve(shellApproval(backend, this.box.root, command), signal)) { return "Denied by user"; }
      signal.throwIfAborted();
      return runShell(this.box, command, signal, backend);
    }
    if (["write_file", "edit_file"].includes(name)) {
      if (!await this.approve(`${name} ${JSON.stringify(args)}`, signal)) { return "Denied by user"; }
      signal.throwIfAborted();
    }
    if (name === "read_file") { return this.read(get("path")); }
    if (name === "list_dir") {
      return (await readdir(await this.box.path(get("path")), { withFileTypes: true })).filter((item) => item.name !== ".stick").map((item) => `${item.name}${item.isDirectory() ? "/" : item.isSymbolicLink() ? " [symlink]" : ""}`).sort().join("\n").slice(0, 32768);
    }
    if (name === "write_file" || name === "edit_file") {
      const path = get("path");
      const content = name === "edit_file" ? replaceUnique(await this.read(path), get("old"), get("new")) : get("content");
      if (Buffer.byteLength(content) > 1048576) { throw new Error("Write exceeds 1 MiB"); }
      await mkdir(dirname(await this.box.path(path)), { recursive: true });
      const target = await this.box.path(path);
      let mode = 0o600;
      try { mode = (await stat(target)).mode & 0o777; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
      }
      const temporary = join(dirname(target), `.stick-${randomUUID()}.tmp`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      try {
        await file.writeFile(content, "utf8"); await file.sync();
        signal.throwIfAborted();
        await this.box.path(path);
        await rename(temporary, target);
      } finally { await file.close(); await rm(temporary, { force: true }); }
      return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
    }
    if (name === "search_files") {
      const query = get("query");
      if (!query) { throw new Error("Empty search query"); }
      const matches: string[] = [];
      let visited = 0;
      const walk = async (path: string): Promise<void> => {
        for (const entry of await readdir(await this.box.path(path), { withFileTypes: true })) {
          signal.throwIfAborted();
          if (++visited > 10000 || matches.length >= 200) { return; }
          if ([".stick", ".git", "node_modules"].includes(entry.name) || entry.isSymbolicLink()) { continue; }
          const child = join(path, entry.name);
          if (entry.isDirectory()) { await walk(child); }
          if (entry.isFile()) {
            let text: string;
            try { text = await this.read(child); } catch { continue; }
            text.split("\n").forEach((line, index) => {
              if (matches.length < 200 && line.includes(query)) { matches.push(`${child}:${index + 1}:${line.slice(0, 300)}`); }
            });
          }
        }
      };
      await walk(".");
      return matches.join("\n").slice(0, 32768) || "No matches";
    }
    throw new Error(`Unknown tool: ${name}`);
  }
}
