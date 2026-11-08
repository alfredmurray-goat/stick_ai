import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { killProcessTree } from "../src/sandbox/process.js";

afterEach(() => { mocks.spawn.mockReset(); vi.useRealTimers(); });
it("uses the Windows system taskkill with force and descendant flags", async () => {
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child;
  });
  await killProcessTree(1234, "win32");
  expect(mocks.spawn.mock.calls[0]?.[0]).toBe(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"));
  expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(["/PID", "1234", "/T", "/F"]);
});
it("reports a Windows process-tree cleanup failure", async () => {
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 5)); return child;
  });
  await expect(killProcessTree(1234, "win32")).rejects.toThrow("verify no descendants remain");
});
it("bounds Windows taskkill itself if the OS utility hangs", async () => {
  vi.useFakeTimers(); const kill = vi.fn();
  mocks.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { kill }));
  const assertion = expect(killProcessTree(1234, "win32")).rejects.toThrow("taskkill timed out");
  await vi.advanceTimersByTimeAsync(5000); await assertion;
  expect(kill).toHaveBeenCalledOnce();
});
