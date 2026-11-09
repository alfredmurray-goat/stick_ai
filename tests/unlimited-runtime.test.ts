import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); })
}));
vi.mock("../src/portable/local-models.js", () => ({ resolveLocalMax: vi.fn(async () => ({ path: "/external/Max.gguf", name: "Max.gguf", source: "linked" })) }));
vi.mock("../src/portable/ports.js", () => ({ reservePort: vi.fn(async () => ({ release: async () => {} })) }));
import { ManagedEngine } from "../src/portable/engine.js";
import { runProcess } from "../src/sandbox/process.js";

function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("keeps loading past the former startup and inactivity deadlines, then accepts a healthy model", async () => {
  vi.useFakeTimers(); const process = child(); mocks.spawn.mockReturnValue(process);
  let ready = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/health")) { return Response.json({ status: ready ? "ok" : "loading" }, { status: ready ? 200 : 503 }); }
    if ((options.headers as Record<string, string>).Authorization === "Bearer invalid-startup-probe") { return new Response(null, { status: 401 }); }
    return Response.json({ data: [{ id: "stellan-1-max" }] });
  }));
  const engine = new ManagedEngine("fixture", "linux-x64", 8080, "temporary", -1, vi.fn());
  const loading = engine.start("stellan-1-max", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(600000);
  expect(engine.child).toBe(process); expect(engine.active).toBeNull();
  ready = true; await vi.advanceTimersByTimeAsync(200); await loading;
  expect(engine.active).toBe("stellan-1-max");
  const args = mocks.spawn.mock.calls[0]![1] as string[];
  expect(args[args.indexOf("--model") + 1]).toBe("/external/Max.gguf");
  expect(args[args.indexOf("--ctx-size") + 1]).toBe("4096");
  await engine.stop();
});
it("cancels a model that remains loading without waiting for a readiness deadline", async () => {
  vi.useFakeTimers(); mocks.spawn.mockReturnValue(child());
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "loading" }, { status: 503 })));
  const engine = new ManagedEngine("fixture", "linux-x64", 8080, "temporary", -1, vi.fn());
  const controller = new AbortController();
  const loading = engine.start("stellan-1-lite", controller.signal).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(600000); controller.abort(); await vi.advanceTimersByTimeAsync(200);
  expect(await loading).toBe(controller.signal.reason); expect(engine.child).toBeNull();
});
it("lets shell commands continue beyond sixty seconds and return normally", async () => {
  vi.useFakeTimers(); const process = child(); mocks.spawn.mockReturnValue(process);
  let finished = false;
  const task = runProcess({ file: "shell", args: [], cwd: "fixture", env: {}, platform: "linux" }, new AbortController().signal).then((value) => { finished = true; return value; });
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(finished).toBe(false); expect(vi.getTimerCount()).toBe(0);
  process.stdout.emit("data", Buffer.from("completed")); process.emit("exit", 0); process.emit("close", 0);
  expect(await task).toBe("exit=0\ncompleted"); expect(vi.getTimerCount()).toBe(0);
});
