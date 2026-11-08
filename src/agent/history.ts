import { appendFile, mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { Sandbox } from "../sandbox/paths.js";
import type { Message } from "../model/types.js";

export class History {
  constructor(private box: Sandbox) {}
  async lock(): Promise<() => Promise<void>> {
    await this.directory();
    const path = await this.box.path(".stick/session.lock", true);
    const handle = await open(path, "wx", 0o600).catch(() => { throw new Error("Project session locked. Close other stick sessions; remove .stick/session.lock only after confirming none are running."); });
    await handle.writeFile(String(process.pid));
    return async () => { await handle.close(); await unlink(path); };
  }
  async load(): Promise<Message[]> {
    let text: string;
    try { text = await readFile(await this.box.path(".stick/history.jsonl", true), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { return []; }
      throw error;
    }
    const messages: Message[] = [];
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) { continue; }
      try {
        const batch: unknown = JSON.parse(line);
        if (!Array.isArray(batch) || batch.some((m) => !m || !["user", "assistant", "tool"].includes(m.role) || typeof m.content !== "string")) { throw new Error("Invalid history entry"); }
        messages.push(...batch as Message[]);
      } catch (error) {
        if (index === lines.length - 1 && !text.endsWith("\n")) {
          await writeFile(await this.box.path(".stick/history.jsonl", true), lines.slice(0, index).join("\n") + (index ? "\n" : ""), { mode: 0o600 });
          break;
        }
        throw new Error(`Corrupt history at line ${index + 1}: ${String(error)}`);
      }
    }
    return messages;
  }
  private async directory(): Promise<void> { await mkdir(await this.box.path(".stick", true), { recursive: true, mode: 0o700 }); }
  async append(batch: Message[]): Promise<void> {
    await this.directory();
    await appendFile(await this.box.path(".stick/history.jsonl", true), JSON.stringify(batch) + "\n", { mode: 0o600 });
  }
  async clear(): Promise<void> {
    await this.directory();
    await writeFile(await this.box.path(".stick/history.jsonl", true), "", { mode: 0o600 });
  }
}
