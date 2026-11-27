import { afterAll, beforeAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { hookConfig, Hooks, useHostHooks, type HookConfig, type HookEvent } from "../src/portable/hooks.js";

// Hooks run through Stellan-Host (--run-hook, --hook-config) against the app's own hooks.ts: the same checks, the
// same outcome for every kind of reply, time limit, cancel and local app notification.
const host = process.env.STELLAN_TEST_HOST ?? resolve(`native-host-app/${process.platform === "win32" ? "Release/stellan-host.exe" : "stellan-host"}`);
const ready = existsSync(host);
if (process.env.STELLAN_REQUIRE_NATIVE_HOST === "1" && !ready) { throw new Error(`The native host is missing (${host})`); }

let dir = "", server: Server | undefined, port = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stick-hooks-native-"));
  server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) { body += chunk; }
    if (request.url === "/fail") { response.writeHead(500); response.end("no"); return; }
    if (request.url === "/chunked") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"decision":"bl'); response.end('ock","reason":"Chunked no"}'); return; }
    if (request.url === "/slow") { setTimeout(() => { response.writeHead(200); response.end("late"); }, 3000); return; }
    const event = JSON.parse(body); response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ additionalContext: `app saw ${event.hook_event_name} for ${event.tool_name ?? "nothing"}` }));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done)); port = (server!.address() as AddressInfo).port;
});
afterAll(async () => { server?.close(); useHostHooks(undefined); if (dir) await rm(dir, { recursive: true, force: true }); });

async function script(name: string, source: string): Promise<string> {
  const path = join(dir, `${name}.mjs`); await writeFile(path, source);
  return `"${process.execPath}" "${path}"`;
}
async function outcome(useHost: boolean, hook: HookConfig, event: HookEvent, details: Record<string, unknown>, cancelAfter?: number, online = true) {
  useHostHooks(useHost ? host : undefined);
  const hooks = new Hooks(dir, dir); hooks.online = online;
  const controller = new AbortController(); if (cancelAfter !== undefined) { setTimeout(() => controller.abort(), cancelAfter); }
  const started = Date.now();
  const result = await hooks.run(event, details, controller.signal, hook);
  return { result, ms: Date.now() - started };
}

it.skipIf(!ready)("checks hook settings exactly as the app does", () => {
  const inputs: unknown[] = [
    null, [], { event: "Nope" }, { event: "Stop", type: "command", command: "echo hi" },
    { event: "PreToolUse", name: "  Guard  ", matcher: "write_file|edit_file", type: "command", command: "  check  ", timeout: "45", enabled: false },
    { event: "Stop", matcher: "x", type: "command", command: "a" }, { event: "PreToolUse", matcher: "(", type: "command", command: "a" },
    { event: "PreToolUse", matcher: "*", type: "command", command: "a" }, { event: "Stop", type: "command", command: "a", timeout: 0 },
    { event: "Stop", type: "command", command: "a", timeout: 601 }, { event: "Stop", type: "command", command: "a", timeout: 2.5 },
    { event: "Stop", type: "command", command: "a", timeout: "" }, { event: "Stop", type: "command", command: "a", timeout: "abc" },
    { event: "Stop", type: "command", command: "   " }, { event: "Stop", type: "command", command: "x".repeat(4097) }, { event: "Stop", type: "other" },
    { event: "Notification", type: "http", url: "http://127.0.0.1:8765/stick" }, { event: "Notification", type: "http", url: "HTTP://LOCALHOST:80/a?b=1" },
    { event: "Notification", type: "http", url: "https://example.com" }, { event: "Notification", type: "http", url: "http://example.com/x" },
    { event: "Notification", type: "http", url: "https://user:pw@example.com/" }, { event: "Notification", type: "http", url: "https://example.com/#frag" },
    { event: "Notification", type: "http", url: "not a url" }, { event: "Notification", type: "http" }, { event: "Stop", name: "x".repeat(81), type: "command", command: "a" }
  ];
  for (const input of inputs) {
    let expected: unknown; try { expected = { hook: hookConfig(input, "hook-00000000-0000-0000-0000-000000000000") }; } catch (error) { expected = { error: (error as Error).message }; }
    const actual = JSON.parse(spawnSync(host, ["--hook-config"], { input: JSON.stringify({ input, id: "hook-00000000-0000-0000-0000-000000000000" }) + "\n", encoding: "utf8" }).stdout);
    expect(actual, JSON.stringify(input)).toEqual(expected);
  }
});

it.skipIf(!ready)("runs command and app hooks with the same outcome as the app", async () => {
  const id = "hook-00000000-0000-0000-0000-000000000000";
  const command = async (name: string, source: string, extra: Partial<HookConfig> = {}): Promise<HookConfig> => hookConfig({ event: "PreToolUse", type: "command", command: await script(name, source), ...extra }, id);
  const app = (path: string, extra: Partial<HookConfig> = {}): HookConfig => hookConfig({ event: "PreToolUse", type: "http", url: `http://127.0.0.1:${port}${path}`, ...extra }, id);
  const details = { tool_name: "write_file", tool_input: { path: "a.txt" } };
  const cases: [string, HookConfig, number?, boolean?][] = [
    ["notes", await command("notes", "process.stdout.write('  remember the tests  ')")],
    ["reads its input", await command("input", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s);console.log(e.hook_event_name, e.tool_name, e.tool_input.path, process.env.STICK_HOOK_EVENT, process.cwd()===process.env.STICK_PROJECT_DIR)})")],
    ["exit 2 blocks", await command("exit2", "process.stderr.write('not allowed');process.exit(2)")],
    ["exit 2 with no text", await command("exit2-empty", "process.exit(2)")],
    ["json block", await command("json", "console.log(JSON.stringify({decision:'block',reason:' Use edit_file ',additionalContext:'ctx'}))")],
    ["json notes", await command("json-notes", "console.log(JSON.stringify({additionalContext:'from json'}))")],
    ["not json", await command("bad-json", "console.log('{not json')")],
    ["fails", await command("fails", "process.stderr.write('broken '.repeat(100));process.exit(3)")],
    ["too slow", await command("slow", "setTimeout(()=>{},10000)", { timeout: 1 })],
    ["too much", await command("loud", "process.stdout.write('x'.repeat(200000))")],
    ["cancelled", await command("cancel", "setTimeout(()=>{},10000)"), 500],
    ["app notes", app("/notes")],
    ["app error", app("/fail")],
    ["app chunked", app("/chunked")],
    ["app timeout", app("/slow", { timeout: 1 })],
    ["internet off, local app", app("/notes"), undefined, false],
    ["internet off, remote app", hookConfig({ event: "PreToolUse", type: "http", url: "https://example.invalid/hook" }, id), undefined, false]
  ];
  for (const [name, hook, cancelAfter, online] of cases) {
    const node = await outcome(false, hook, "PreToolUse", details, cancelAfter, online ?? true);
    const native = await outcome(true, hook, "PreToolUse", details, cancelAfter, online ?? true);
    expect(native.result, name).toEqual(node.result);
    if (name === "too slow" || name === "cancelled") { expect(native.ms, name).toBeLessThan(5000); }
  }
}, 120000);
