import { expect, it, vi } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { webApp } from "../src/portable/web.js";
import type { ManagedEngine } from "../src/portable/engine.js";

async function fixture(start: (model: string, signal: AbortSignal) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "stick-desktop-service-")); await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const engine = { active: null, start, stop: vi.fn(async () => {}), contextSize: 8192 };
  const stop = vi.fn(async () => {});
  const app = await webApp({ root, engine: engine as unknown as ManagedEngine, bytes: 8 * 1024 ** 3, choices: ["stellan-1-lite"], noSwap: false, desktop: true, report: vi.fn(), log: vi.fn(), stop });
  const url = new URL(app.url);
  return { app, engine, stop, async api(path: string, data?: object) {
    const response = await fetch(url.origin + path, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); return response.json();
  }, async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}
it("exposes friendly startup errors and allows manually selecting faster settings", async () => {
  const service = await fixture(async () => { throw new Error("private startup details"); });
  try {
    await expect(service.app.start()).rejects.toThrow("private startup details");
    expect((await service.api("/api/state")).problem.action).toBe("Retry");
    await expect(service.app.start()).rejects.toThrow("private startup details");
    const state = await service.api("/api/state"); expect(state.problem.action).toBe("Retry"); expect(state.problem.message).not.toContain("private startup details");
    await service.api("/api/faster", {}); expect(service.engine.contextSize).toBe(4096);
  } finally { await service.close(); }
});
it("cancels model loading while keeping the local app service available", async () => {
  const service = await fixture(async (_model, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  try {
    const loading = service.app.start().catch((error: unknown) => error);
    await service.api("/api/cancel", {}); expect((await loading) instanceof Error).toBe(true);
    expect((await service.api("/api/state")).problem.action).toBe("OK");
  } finally { await service.close(); }
});

it("keeps loading through a browser disconnect until explicitly cancelled", async () => {
  const service = await fixture(async (_model, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  try {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const loading = service.app.start().catch((error: unknown) => error);
    await service.api("/api/state");
    await vi.advanceTimersByTimeAsync(600000);
    expect(service.stop).not.toHaveBeenCalled();
    await service.api("/api/cancel", {}); expect(await loading).toBeInstanceOf(Error);
  } finally { vi.useRealTimers(); await service.close(); }
});
