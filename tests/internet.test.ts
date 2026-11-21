import { expect, it, vi } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { webApp } from "../src/portable/web.js";
import { contextPlan, type ManagedEngine } from "../src/portable/engine.js";
import { offlineMessage, remote } from "../src/portable/mcp.js";
import { Hooks } from "../src/portable/hooks.js";

const GiB = 1024 ** 3;

it("tells servers on this computer apart from ones on the internet", () => {
  expect(remote({ id: "a", name: "a", transport: "stdio", command: "node" })).toBe(false);
  expect(remote({ id: "b", name: "b", transport: "http", url: "http://127.0.0.1:3000/mcp" })).toBe(false);
  expect(remote({ id: "c", name: "c", transport: "http", url: "https://mcp.example.com/mcp" })).toBe(true);
});

it("skips hooks that notify other computers while Allow internet is off", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-offline-hooks-"));
  const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    const hooks = new Hooks(root, root, vi.fn());
    const hook = await hooks.add({ name: "Phone", event: "Stop", type: "http", url: "https://hooks.example.com/stick", timeout: 5 });
    hooks.online = false;
    const outcome = await hooks.run("Stop", {}, new AbortController().signal, hook);
    expect(outcome.problems.join()).toMatch(/Allow internet is off/);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it("is on by default, and when turned off it blocks web search and GitHub and remembers that on the stick", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-internet-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const engine = { active: null as string | null, baseUrl: "http://127.0.0.1:9", key: "k", plan: contextPlan(16 * GiB), async start(model: string) { this.active = model; }, async stop() { this.active = null; } };
  const open = async () => {
    const app = await webApp({ root, engine: engine as unknown as ManagedEngine, bytes: 16 * GiB, choices: ["stellan-1-lite"], noSwap: true, report: vi.fn(), log: vi.fn(), stop: async () => {} });
    const url = new URL(app.url);
    const api = async (path: string, data?: object): Promise<{ status: number; body: any }> => { const response = await fetch(url.origin + path, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, body: await response.json() }; };
    return { app, api };
  };
  try {
    const first = await open();
    expect((await first.api("/api/state")).body.internet).toBe(true);
    expect((await first.api("/api/extensions")).body.webSearch).toBe(true);
    expect((await first.api("/api/internet", { enabled: false })).status).toBe(200);
    expect((await first.api("/api/state")).body.internet).toBe(false);
    expect((await first.api("/api/extensions")).body.webSearch).toBe(false);
    expect(await first.api("/api/github/signin/start", {})).toEqual({ status: 400, body: { error: offlineMessage } });
    expect(await first.api("/api/github/connect", { repository: "octo/repo", token: "" })).toEqual({ status: 400, body: { error: offlineMessage } });
    await first.app.close();
    const second = await open();
    expect((await second.api("/api/state")).body.internet).toBe(false);
    await second.api("/api/internet", { enabled: true });
    expect((await second.api("/api/extensions")).body.webSearch).toBe(true);
    await second.app.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
