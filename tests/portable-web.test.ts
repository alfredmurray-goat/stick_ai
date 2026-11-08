import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GiB, ramStatus } from "../src/config/models.js";
import { Ollama } from "../src/model/ollama.js";
import { coderSystem } from "../src/agent/delegate.js";
import { webApp } from "../src/portable/web.js";
import { codeWithSwap, type ManagedEngine } from "../src/portable/engine.js";
import { listenLocal } from "../src/portable/ports.js";

it("serves a private browser session, swaps models, preserves history and applies approved Max code", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-web-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const bodies: Record<string, any>[] = [];
  const code = "export function greet() { return 1; }";
  const responses = [
    '<tool_call>{"name":"delegate_code","arguments":{"task":"write greet","context":"TypeScript source"}}</tool_call>',
    code,
    `<tool_call>${JSON.stringify({ name: "write_file", arguments: { path: "greet.ts", content: code } })}</tool_call>`,
    "<done>Saved your function.</done>"
  ];
  const inference = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) { text += chunk; }
    expect(request.headers.authorization).toBe("Bearer test-key");
    bodies.push(JSON.parse(text));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: responses.shift() }, finish_reason: "stop" }] })}\n\n`);
  });
  const port = await listenLocal(inference);
  const order: string[] = [];
  const engine = {
    active: null as string | null, baseUrl: `http://127.0.0.1:${port}`, key: "test-key",
    async start(model: string) { expect(this.active).toBe(null); this.active = model; order.push(`start ${model}`); },
    async stop() { order.push(`stop ${this.active}`); this.active = null; },
    async code(task: string, context: string, signal: AbortSignal, report: (text: string) => void) {
      return codeWithSwap(this, async () => {
        expect(this.active).toBe("stellan-1-max");
        const result = await new Ollama("stellan-1-max", this.baseUrl, false, ramStatus(16 * GiB), { apiKey: this.key, specialist: true }).complete([{ role: "system", content: coderSystem }, { role: "user", content: `${task}\n${context}` }], signal, () => {});
        return result.content;
      }, signal, report);
    }
  };
  const app = await webApp({ root, engine: engine as unknown as ManagedEngine, bytes: 16 * GiB, choices: ["stellan-1-lite", "stellan-1-max"], noSwap: false, report: vi.fn(), log: vi.fn(), stop: async () => {} });
  const url = new URL(app.url); const authorization = `Bearer ${url.hash.slice(1)}`;
  async function api(path: string, body?: object) {
    const response = await fetch(url.origin + path, { method: body ? "POST" : "GET", headers: { Authorization: authorization, Origin: url.origin, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.ok).toBe(true); return response.json() as Promise<any>;
  }
  try {
    expect((await fetch(url.origin + "/api/state")).status).toBe(403);
    const page = await fetch(url.origin); expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'"); expect(await page.text()).toContain("Start chatting");
    await api("/api/start", { model: "stellan-1-lite" });
    await api("/api/task", { text: "Add greet" });
    let approved = false; let state: any;
    for (let attempt = 0; attempt < 150; attempt++) {
      state = await api("/api/state");
      const event = state.events.find((event: any) => event.kind === "approval");
      if (event && !approved) { approved = true; await api("/api/approve", { id: event.data.id, allow: true }); }
      if (state.phase === "ready" && approved) { break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(approved).toBe(true); expect(state.phase).toBe("ready");
    expect(await readFile(join(root, "app/project/greet.ts"), "utf8")).toBe(code);
    expect(order).toEqual(["start stellan-1-lite", "stop stellan-1-lite", "start stellan-1-max", "stop stellan-1-max", "start stellan-1-lite"]);
    expect(bodies.map((body) => body.model)).toEqual(["stellan-1-lite", "stellan-1-max", "stellan-1-lite", "stellan-1-lite"]);
    expect(bodies[2]!.messages.some((message: any) => message.content === `<tool_result>${code}</tool_result>`)).toBe(true);
    expect(bodies[2]!.messages.some((message: any) => message.content === "Add greet")).toBe(true);
  } finally { await app.close(); inference.closeAllConnections(); await new Promise<void>((resolve) => inference.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 15000);
