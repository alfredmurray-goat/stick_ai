import { assets } from "./portable-fixtures.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GiB } from "../src/config/models.js";
import { targetFor, portableModels, targets, executableName, llamaRelease, nodeRelease } from "../src/portable/platform.js";
import { hashFile, verifyStick, staticFiles, type Manifest } from "../src/portable/integrity.js";
import { reservePort } from "../src/portable/ports.js";
import { buildStick, userReadme, type StickInputs } from "../src/portable/build.js";
import { dryRunActions } from "../src/portable/entry.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temp() { const path = await mkdtemp(join(tmpdir(), "stick-portable-")); roots.push(path); return path; }
it.each([["darwin", "arm64", "macos-arm64"], ["darwin", "x64", "macos-x64"], ["win32", "x64", "windows-x64"], ["linux", "x64", "linux-x64"]])("selects %s %s", (platform, arch, expected) => { expect(targetFor(platform!, arch!)).toBe(expected); });
it("refuses unsupported CPUs", () => { expect(() => targetFor("win32", "arm64")).toThrow(); expect(() => targetFor("linux", "arm64")).toThrow(); });
it.each([[8, 1], [15.9, 1], [16, 2]])("locks the model list at %s GB", (memory, count) => { expect(portableModels(memory! * GiB, true)).toHaveLength(count!); });
it("refuses less than 8 GB and hides absent Max", () => { expect(() => portableModels(7 * GiB, true)).toThrow(); expect(portableModels(16 * GiB, false)).toEqual(["stellan-1-lite"]); });
it("skips an occupied port instead of reusing another server", async () => {
  const first = await reservePort();
  try { const next = await reservePort(first.port, 8099); expect(next.port).not.toBe(first.port); await next.release(); await expect(reservePort(first.port, first.port)).rejects.toThrow(); } finally { await first.release(); }
});
it("dry-run describes every action without launching a process or creating files", async () => {
  const root = await temp(); const before = await staticFiles(root);
  for (const [os, arch] of [["darwin", "arm64"], ["win32", "x64"], ["linux", "x64"]]) {
    const actions = dryRunActions(root, os as NodeJS.Platform, arch, 16 * GiB);
    expect(actions.join(" ")).toContain("127.0.0.1"); expect(actions.join(" ")).toContain("until ready or cancelled"); expect(actions.join(" ")).toContain("stop Lite");
  }
  expect(await staticFiles(root)).toEqual(before);
});
it("builds the layout, preserves permissions and catches a tampered model", async () => {
  const root = await temp(); const input = await assets(root); const out = join(root, "stick");
  const manifest = await buildStick(resolve("."), out, input);
  expect(manifest.llamaRelease).toBe(llamaRelease); expect(manifest.nodeRelease).toBe(nodeRelease);
  await verifyStick(out);
  expect(await readFile(join(out, "Start.bat"), "utf8")).toContain("Get-FileHash");
  expect(await readFile(join(out, "Start.bat"), "utf8")).toContain("\r\n");
  if (process.platform !== "win32") { expect((await lstat(join(out, "Start.command"))).mode & 0o111).not.toBe(0); }
  await writeFile(join(out, "models/stellan-1-lite-q4_k_m.gguf"), "tampered");
  await expect(verifyStick(out)).rejects.toThrow("damaged");
}, 20000);
it("fails before output if a required input is missing", async () => {
  const root = await temp(); const input = await assets(root); await rm(input.max);
  await expect(buildStick(resolve("."), join(root, "stick"), input)).rejects.toThrow();
  await expect(lstat(join(root, "stick"))).rejects.toThrow();
});
it("keeps the plain-language readme under 200 words", () => { expect(userReadme.split(/\s+/).length).toBeLessThan(200); expect(userReadme).toContain("If macOS blocks this, right-click Start and choose Open, once."); });

it("runs the generated native start file in dry-run mode from a path with spaces", async () => {
  const root = await temp(); const input = await assets(root);
  const target = targetFor(process.platform, process.arch);
  input.nodes[target] = process.execPath;
  const out = join(root, "A stick with spaces");
  await buildStick(resolve("."), out, input);
  const exec = promisify(execFile);
  const running = process.platform === "win32" ? exec(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `\"\"${join(out, "Start.bat")}\" --dry-run\"`], { windowsVerbatimArguments: true, timeout: 20000 }) : exec(join(out, process.platform === "darwin" ? "Start.command" : "start.sh"), ["--dry-run"], { timeout: 20000 });
  if (process.platform === "win32") { running.child.stdin.end("\r\n"); }
  let result;
  try { result = await running; } catch (error) { console.error("Launcher diagnostic", (error as any).stdout, (error as any).stderr, await readFile(join(out, "logs/launcher.log"), "utf8").catch(() => "No launcher log")); throw error; }
  expect(result.stdout).toContain("Choose an unused model port between 8080 and 8099");
  expect(result.stdout).toContain(target);
}, 30000);

it("allows harmless desktop metadata but rejects unlisted application files", async () => {
  const root = await temp(); const input = await assets(root); const out = join(root, "stick");
  await buildStick(resolve("."), out, input);
  await writeFile(join(out, ".DS_Store"), "desktop metadata");
  await verifyStick(out);
  await writeFile(join(out, "bin/windows-x64/unlisted.dll"), "unlisted library");
  await expect(verifyStick(out)).rejects.toThrow("damaged");
});

it("previews startup on low-memory CI hosts without bypassing the real memory check", () => {
  expect(dryRunActions("fixture", "linux", "x64", 7 * GiB).join(" ")).toContain("would stop launch");
  expect(() => portableModels(7 * GiB, false)).toThrow();
});
