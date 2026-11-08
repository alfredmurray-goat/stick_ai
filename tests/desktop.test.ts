import { expect, it, vi } from "vitest";
import { desktopDryRun, launchDesktop, type DesktopDriver } from "../src/portable/desktop.js";
import { portableModels } from "../src/portable/platform.js";
const gb = 1024 ** 3;
function driver() {
  const calls: string[] = [];
  const mock = Object.fromEntries(["verify", "prepare", "startLite", "waitHealthy", "openChat", "stop", "cleanup"].map((name) => [name, vi.fn(async () => { calls.push(name); })])) as unknown as DesktopDriver;
  return { mock, calls };
}
it.each([8, 15.9, 16])("desktop RAM lock at %s GB keeps Lite available", (ram) => {
  expect(portableModels(ram * gb, true)).toEqual(ram < 16 ? ["stellan-1-lite"] : ["stellan-1-lite", "stellan-1-max"]);
});
it("verifies before launching, waits for health before chat, and cleans up on quit", async () => {
  const { mock, calls } = driver(); const stop = await launchDesktop(mock, new AbortController().signal, 16 * gb);
  expect(calls).toEqual(["verify", "prepare", "startLite", "waitHealthy", "openChat"]);
  await stop(); expect(calls.slice(-2)).toEqual(["stop", "cleanup"]);
});
it("does not open chat after a failed model start and still cleans up", async () => {
  const { mock, calls } = driver(); mock.startLite = vi.fn(async () => { throw new Error("load failed"); });
  await expect(launchDesktop(mock, new AbortController().signal, 8 * gb)).rejects.toThrow("load failed");
  expect(calls).toEqual(["verify", "prepare", "stop", "cleanup"]);
});
it.each([["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["linux", "x64"]])("dry-run plans %s %s without processes", (os, arch) => {
  const plan = desktopDryRun("fixture", os as NodeJS.Platform, arch as NodeJS.Architecture, 8 * gb).join("\n");
  expect(plan).toContain("locked"); expect(plan).toContain("127.0.0.1"); expect(plan).toContain("SHA256"); expect(plan).toContain("delete temporary");
});
it("includes all four desktop bundles and their hashes in the stick build", async () => {
  const { mkdtemp, mkdir, cp, writeFile, rm } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { assets } = await import("./portable-fixtures.js"); const { buildStick } = await import("../src/portable/build.js"); const { verifyStick } = await import("../src/portable/integrity.js");
  const directory = await mkdtemp(join(tmpdir(), "stick-desktop-build-"));
  try {
    const input = await assets(directory); const desktop = {} as NonNullable<typeof input.desktop>;
    for (const target of ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"] as const) {
      if (target.startsWith("macos")) {
        desktop[target] = join(directory, target + ".app"); await mkdir(join(desktop[target], "Contents/MacOS"), { recursive: true }); await cp(input.servers[target], join(desktop[target], "Contents/MacOS/stick-ai"));
      } else { desktop[target] = input.servers[target]; }
    }
    const notices = join(directory, "native-notices"); await mkdir(notices); await writeFile(join(notices, "NOTICE.txt"), "Fixture notice");
    const output = join(directory, "out"); const manifest = await buildStick(resolve("."), output, { ...input, desktop, desktopLicenses: notices });
    expect(manifest.files.filter((record) => record.path.startsWith("desktop/"))).toHaveLength(4);
    expect(manifest.files.some((record) => record.path === "LICENSES/desktop/NOTICE.txt")).toBe(true);
    await expect(verifyStick(output)).resolves.toHaveProperty("format", 1);
    await writeFile(join(output, "desktop/windows-x64/stick-ai.exe"), "tampered"); await expect(verifyStick(output)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
