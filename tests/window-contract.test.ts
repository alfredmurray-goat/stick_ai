import { afterAll, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { webApp } from "../src/portable/web.js";
import type { ManagedEngine } from "../src/portable/engine.js";
import { listenLocal } from "../src/portable/ports.js";

/**
 * The window server's contract (docs/HOST_WINDOW_SERVER.md, step 1): scripted sessions over HTTP only, recorded as
 * transcripts with run-to-run noise removed. Node's server (web.ts) defines the expected transcript; when a Host
 * window server is available (STICK_TEST_WINDOW_HOST=path to stellan-host), it must produce the same transcript.
 */
interface Window { origin: string; token: string; close(): Promise<void> }
interface Model { port: number; bodies: any[]; replies: string[]; close(): Promise<void> }
const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => { for (const task of cleanup.splice(0).reverse()) { await task(); } });

async function fakeModel(): Promise<Model> {
  const bodies: any[] = []; const replies: string[] = [];
  const server: Server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) { text += chunk; }
    bodies.push(JSON.parse(text));
    const reply = replies.shift() ?? "<done>Done.</done>";
    if (reply.startsWith("WAIT:")) { await new Promise((done) => setTimeout(done, Number(reply.slice(5)))); }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.startsWith("WAIT:") ? "<done>Late.</done>" : reply }, finish_reason: "stop" }] })}\n\n`);
  });
  const port = await listenLocal(server);
  return { port, bodies, replies, async close() { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stick-contract-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function nodeWindow(root: string, model: Model): Promise<Window> {
  const engine = { active: null as string | null, baseUrl: `http://127.0.0.1:${model.port}`, key: "contract-key", async start(name: string) { this.active = name; }, async stop() { this.active = null; } };
  const app = await webApp({ root, engine: engine as unknown as ManagedEngine, bytes: 24 * 1024 ** 3, choices: ["stellan-1-lite", "stellan-1-max"], noSwap: false, report: vi.fn(), log: vi.fn(), stop: async () => {} });
  const url = new URL(app.url);
  return { origin: url.origin, token: url.hash.slice(1), close: () => app.close() };
}
async function hostWindow(root: string, model: Model): Promise<Window> {
  const host = process.env.STICK_TEST_WINDOW_HOST!;
  const child: ChildProcess = spawn(host, ["--window", root, "--test-model", `http://127.0.0.1:${model.port}`, "--test-model-key", "contract-key"], { stdio: ["pipe", "pipe", "inherit"] });
  const ready = await new Promise<{ url: string }>((done, fail) => {
    createInterface({ input: child.stdout! }).on("line", (line) => { try { const event = JSON.parse(line); if (event.event === "ready") done(event); } catch {} });
    child.once("exit", () => fail(new Error("The Host window server stopped")));
  });
  const url = new URL(ready.url);
  return { origin: url.origin, token: url.hash.slice(1), async close() { child.stdin!.end(); await new Promise((done) => child.once("exit", done)); } };
}

// Values that legitimately differ between runs: temporary paths, random IDs, timings and free disk space.
function normalise(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    return value.split(root).join("<root>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>").replace(/chats\/[0-9a-f]{24}\//g, "chats/<hash>/");
  }
  if (Array.isArray(value)) { return value.map((item) => normalise(item, root)); }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (["key", "at", "time", "elapsedSeconds", "free", "startedAt", "durationMs"].includes(key)) { result[key] = typeof item; continue; }
      result[key] = normalise(item, root);
    }
    return result;
  }
  return value;
}
type Step = { method: string; path: string; status: number; body: unknown };
async function session(start: (root: string, model: Model) => Promise<Window>, script: (call: (path: string, body?: object, extra?: { headers?: Record<string, string>; raw?: boolean; quiet?: boolean }) => Promise<any>, model: Model, root: string) => Promise<void>): Promise<{ transcript: Step[]; bodies: unknown[] }> {
  const root = await project(); const model = await fakeModel(); cleanup.push(() => model.close());
  const window = await start(root, model);
  const transcript: Step[] = [];
  const call = async (path: string, body?: object, extra: { headers?: Record<string, string>; raw?: boolean; quiet?: boolean } = {}) => {
    const response = await fetch(window.origin + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${window.token}`, Origin: window.origin, ...(body ? { "Content-Type": "application/json" } : {}), ...extra.headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let parsed: unknown = text; try { parsed = JSON.parse(text); } catch {}
    if (extra.quiet) { return parsed; }
    transcript.push({ method: body ? "POST" : "GET", path: path.replace(/wait=[^&]*/, "wait=<key>"), status: response.status, body: extra.raw ? `<${text.length} bytes>` : normalise(parsed, root) });
    return parsed;
  };
  try { await script(call, model, root); } finally { await window.close(); }
  return { transcript, bodies: normalise(model.bodies, root) as unknown[] };
}
// Waits for a state without recording each check (how many checks it takes depends on timing), then records the
// state once it is reached.
async function settle(call: (path: string, body?: object, extra?: { quiet?: boolean }) => Promise<any>, until: (state: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (until(await call("/api/state", undefined, { quiet: true }))) { return call("/api/state"); }
    await new Promise((done) => setTimeout(done, 25));
  }
  const last = await call("/api/state", undefined, { quiet: true });
  throw new Error(`The window never reached the expected state: ${last.phase} ${last.failure} ${JSON.stringify(last.events.map((event: any) => [event.kind, event.text ?? event.data]).slice(-6))}`);
}

const scenarios: Record<string, Parameters<typeof session>[1]> = {
  "guards and the empty window": async (call) => {
    await call("/api/state", undefined, { headers: { Authorization: "Bearer wrong" } });
    await call("/api/state", undefined, { headers: { Origin: "http://evil.example" } });
    await call("/api/nothing-here");
    await call("/api/state");
    await call("/api/dismiss", {});
  },
  "settings change wakes a waiting window": async (call) => {
    const first = await call("/api/state");
    const waiting = call(`/api/state?wait=${encodeURIComponent(first.key)}&after=0`);
    await new Promise((done) => setTimeout(done, 100));
    await call("/api/personal", { name: "Ada", about: "Builds things", style: "concise", preferences: "" });
    const woken = await waiting;
    expect(woken.personal.name).toBe("Ada");
  },
  "a task asks to run a command and the user says no": async (call, model, root) => {
    model.replies.push(`<tool_call>${JSON.stringify({ name: "run_shell", arguments: { command: "echo hello > note.txt" } })}</tool_call>`, "<done>Left it alone.</done>");
    await call("/api/start", { model: "stellan-1-lite" });
    await settle(call, (state) => state.phase === "ready");
    await call("/api/task", { text: "Make a note" });
    const asking = await settle(call, (state) => state.events.some((event: any) => event.kind === "approval"));
    await call("/api/approve", { id: asking.events.find((event: any) => event.kind === "approval").data.id, allow: false });
    await settle(call, (state) => state.events.some((event: any) => event.kind === "task-complete"));
    expect(existsSync(join(root, "app/project/note.txt"))).toBe(false);
  },
  "a running task can be cancelled": async (call, model) => {
    model.replies.push("WAIT:3000");
    await call("/api/start", { model: "stellan-1-lite" });
    await settle(call, (state) => state.phase === "ready");
    await call("/api/task", { text: "Take your time" });
    await new Promise((done) => setTimeout(done, 200));
    await call("/api/cancel", {});
    await settle(call, (state) => state.phase === "ready" && state.events.some((event: any) => event.kind === "task-cancelled" || event.kind === "error" || event.kind === "task-complete"));
  }
};

for (const [name, script] of Object.entries(scenarios)) {
  it(`window contract: ${name}`, async () => {
    const expected = await session(nodeWindow, script);
    expect(expected.transcript.length).toBeGreaterThan(0);
    // The same script twice on Node must give the same transcript, or the contract itself is noisy.
    const again = await session(nodeWindow, script);
    expect(again.transcript).toEqual(expected.transcript);
    expect(again.bodies).toEqual(expected.bodies);
    if (process.env.STICK_TEST_WINDOW_HOST) {
      const actual = await session(hostWindow, script);
      expect(actual.transcript).toEqual(expected.transcript);
      expect(actual.bodies).toEqual(expected.bodies);
    }
  }, 60000);
}
