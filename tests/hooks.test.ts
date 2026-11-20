import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GiB } from "../src/config/models.js";
import { Hooks, HookError, hookConfig, readReply } from "../src/portable/hooks.js";
import { webApp } from "../src/portable/web.js";
import type { ManagedEngine } from "../src/portable/engine.js";
import { listenLocal } from "../src/portable/ports.js";

const node = (script: string) => `"${process.execPath}" "${script}"`;

it("checks hook settings and refuses anything that could reach beyond this computer over plain HTTP", () => {
  expect(hookConfig({ event: "Stop", type: "command", command: "say done" }, "hook-x")).toMatchObject({ name: "Stop", timeout: 30, enabled: true, matcher: "" });
  expect(() => hookConfig({ event: "Stop", type: "http", url: "http://example.com/hook" }, "x")).toThrow(HookError);
  expect(hookConfig({ event: "Notification", type: "http", url: "http://127.0.0.1:8765/stick" }, "x").url).toBe("http://127.0.0.1:8765/stick");
  expect(() => hookConfig({ event: "Stop", type: "command", command: "x", matcher: "edit_file" }, "x")).toThrow(/tool hooks/);
  expect(() => hookConfig({ event: "PreToolUse", type: "command", command: "x", matcher: "(" }, "x")).toThrow(/filter/);
  expect(() => hookConfig({ event: "Whenever", type: "command", command: "x" }, "x")).toThrow(/when/);
  expect(() => hookConfig({ event: "Stop", type: "command", command: "x", timeout: 0 }, "x")).toThrow(/time limit/);
});

it("reads hook replies like Claude Code: exit 2 or a block decision stops, other output becomes notes", () => {
  expect(readReply(2, "", "not allowed")).toEqual({ blocked: "not allowed", context: "" });
  expect(readReply(0, '{"decision":"block","reason":"tests are red"}', "")).toEqual({ blocked: "tests are red", context: "" });
  expect(readReply(0, '{"additionalContext":"Use tabs."}', "")).toEqual({ context: "Use tabs." });
  expect(readReply(0, "plain note\n", "")).toEqual({ context: "plain note" });
  expect(readReply(1, "", "boom").problem).toContain("code 1");
});

it("runs command hooks with the event on standard input, filters by tool, saves them and stops slow ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-hooks-"));
  try {
    const guard = join(root, "guard.mjs"), slow = join(root, "slow.mjs");
    await writeFile(guard, String.raw`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s);if(e.tool_input&&e.tool_input.path==='.env'){console.error('Keep .env private');process.exit(2)}console.log('Seen '+e.hook_event_name+' in '+e.cwd.split(/[\/]/).pop()+' via '+process.env.STICK_HOOK_EVENT)})`);
    await writeFile(slow, "setTimeout(()=>{},10000)");
    const hooks = new Hooks(root, root);
    await hooks.add({ name: "Guard", event: "PreToolUse", matcher: "read_file|edit_file", type: "command", command: node(guard) });
    await hooks.add({ name: "Slow", event: "Stop", type: "command", command: node(slow), timeout: 1 });
    const signal = new AbortController().signal;
    expect((await hooks.run("PreToolUse", { tool_name: "read_file", tool_input: { path: ".env" } }, signal)).blocked).toBe("Keep .env private (hook “Guard”)");
    expect((await hooks.run("PreToolUse", { tool_name: "read_file", tool_input: { path: "a.ts" } }, signal)).context).toBe(`Seen PreToolUse in ${root.split(/[\\/]/).pop()} via PreToolUse`);
    expect((await hooks.run("PreToolUse", { tool_name: "list_dir", tool_input: { path: ".env" } }, signal)).ran).toEqual([]);
    const started = Date.now(); const stopped = await hooks.run("Stop", { status: "finished" }, signal);
    expect(stopped.problems[0]).toContain("longer than 1 seconds"); expect(Date.now() - started).toBeLessThan(8000);
    const reloaded = new Hooks(root, root); await reloaded.load();
    expect(reloaded.view().map((hook) => hook.name)).toEqual(["Guard", "Slow"]);
    await reloaded.setEnabled(reloaded.view()[0]!.id, false); await reloaded.remove(reloaded.view()[1]!.id);
    expect(JSON.parse(await readFile(join(root, "logs/extensions/hooks.json"), "utf8")).hooks).toHaveLength(1);
    expect((await reloaded.run("PreToolUse", { tool_name: "read_file", tool_input: { path: ".env" } }, signal)).blocked).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

it("stops a blocked tool before its approval, adds hook notes, and tells a local app when Stellan finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-hooks-web-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const received: any[] = [];
  const listener = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) { text += chunk; } const event = JSON.parse(text); received.push(event);
    response.writeHead(200, { "Content-Type": "application/json" });
    if (event.hook_event_name === "PreToolUse" && event.tool_name === "write_file") { response.end(JSON.stringify({ decision: "block", reason: "Writing is paused today" })); return; }
    if (event.hook_event_name === "UserPromptSubmit" && /secret/i.test(event.prompt)) { response.end(JSON.stringify({ decision: "block", reason: "Don't paste secrets" })); return; }
    if (event.hook_event_name === "UserPromptSubmit") { response.end(JSON.stringify({ additionalContext: "The user prefers British spelling." })); return; }
    response.end("{}");
  });
  const hookPort = await listenLocal(listener);
  const bodies: any[] = [];
  const replies = ['<tool_call>{"name":"write_file","arguments":{"path":"a.txt","content":"hi"}}</tool_call>', "<done>I couldn't write the file.</done>"];
  const inference = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) { text += chunk; } bodies.push(JSON.parse(text));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: replies.shift() ?? "<done>ok</done>" }, finish_reason: "stop" }] })}\n\n`);
  });
  const port = await listenLocal(inference);
  const engine = { active: null as string | null, baseUrl: `http://127.0.0.1:${port}`, key: "k", async start(model: string) { this.active = model; }, async stop() { this.active = null; } };
  const app = await webApp({ root, engine: engine as unknown as ManagedEngine, bytes: 8 * GiB, choices: ["stellan-1-lite"], noSwap: true, report: vi.fn(), log: vi.fn(), stop: async () => {} });
  const url = new URL(app.url);
  const api = async (path: string, data?: object): Promise<any> => (await fetch(url.origin + path, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) })).json();
  try {
    for (const event of ["UserPromptSubmit", "PreToolUse", "Stop"]) { expect((await api("/api/hooks/add", { name: event, event, type: "http", url: `http://127.0.0.1:${hookPort}/stick` })).hook.id).toMatch(/^hook-/); }
    expect((await api("/api/hooks/add", { event: "Stop", type: "http", url: "http://example.com/x" })).error).toContain("HTTPS");
    const test = await api("/api/hooks/test", { id: (await api("/api/extensions")).hooks[2].id }); expect(test.problems).toEqual([]);
    received.length = 0;
    await app.start("stellan-1-lite");
    await api("/api/task", { text: "Make a.txt" });
    await vi.waitFor(async () => expect((await api("/api/state")).events.some((event: any) => event.kind === "task-complete")).toBe(true));
    const state = await api("/api/state");
    expect(state.events.some((event: any) => event.kind === "approval")).toBe(false);
    expect(bodies[0].messages[1].content).toContain("The user prefers British spelling.");
    expect(bodies[1].messages.at(-1).content).toContain("A hook blocked this tool call: Writing is paused today (hook “PreToolUse”)");
    await vi.waitFor(() => expect(received.some((event) => event.hook_event_name === "Stop")).toBe(true));
    expect(received.find((event) => event.hook_event_name === "Stop")).toMatchObject({ status: "finished", prompt: "Make a.txt", last_assistant_message: "I couldn't write the file." });
    const before = bodies.length;
    await api("/api/task", { text: "Here is my secret key" });
    await vi.waitFor(async () => expect((await api("/api/state")).problem?.message).toContain("Don't paste secrets"));
    expect(bodies.length).toBe(before);
  } finally { await app.close(); for (const server of [inference, listener]) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } await rm(root, { recursive: true, force: true }); }
}, 30000);
