import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../src/sandbox/paths.js";
import { cleanEnvironment, detectBackend, macProfile, processSpec, restrictedWarning, shellApproval, shellArguments, type Backend } from "../src/sandbox/backends.js";
import { runProcess } from "../src/sandbox/process.js";
import { runShell } from "../src/sandbox/shell.js";
import { Tools } from "../src/tools/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "stick-sandbox-")); roots.push(root);
  return Sandbox.create(root);
}
for (const platform of ["darwin", "win32", "linux"] as const) {
  describe(`${platform} sandbox selection`, () => {
    const shell = platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/bash";
    it("selects the native backend when available, or warns on Windows", async () => {
      const backend = await detectBackend(await fixture(), { platform, env: { STICK_SHELL: shell }, executable: async () => true, probe: async () => {} });
      expect(backend.name).toBe(platform === "darwin" ? "sandbox-exec" : platform === "linux" ? "bubblewrap" : "restricted");
      if (platform === "win32") { expect(shellApproval(backend, "project", "echo ok")).toContain(restrictedWarning); }
    });
    it("warns before approval if native enforcement is missing", async () => {
      const box = await fixture();
      const backend = await detectBackend(box, { platform, env: { STICK_SHELL: shell }, executable: async (path) => path === shell });
      expect(backend.name).toBe("restricted");
      const approve = vi.fn(async (_description: string, _signal: AbortSignal) => false); const warn = vi.fn();
      const tools = new Tools(box, approve, backend, warn);
      const command = "echo exact & command";
      expect(await tools.execute({ id: "1", type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command }) } }, new AbortController().signal)).toBe("Denied by user");
      expect(approve.mock.calls[0]?.[0]).toContain(restrictedWarning);
      expect(approve.mock.calls[0]?.[0]).toContain(JSON.stringify(command));
      expect(approve.mock.calls[0]?.[0]).toContain(box.root);
      expect(warn).toHaveBeenCalledWith(backend.warning);
    });
    it("does not silently accept a failed native capability probe", async () => {
      const backend = await detectBackend(await fixture(), { platform, env: { STICK_SHELL: shell }, executable: async () => true, probe: async () => { throw new Error("denied"); } });
      expect(backend.name).toBe("restricted"); expect(backend.warning).toContain("NOT an OS sandbox");
    });
  });
}
it("generates a deny-network macOS profile and a network namespace on Linux", () => {
  const profile = macProfile('/tmp/project "quoted"');
  expect(profile).toContain("(deny default)"); expect(profile).toContain("(deny network*)");
  expect(profile).toContain(JSON.stringify('/tmp/project "quoted"'));
  const backend: Backend = { platform: "linux", name: "bubblewrap", shell: "/bin/bash", isolated: true };
  expect(processSpec(backend, "/tmp/project", "echo ok").args).toContain("--unshare-all");
});
it("cleans credentials and injection variables, preserving required Windows variables", () => {
  const env = cleanEnvironment("C:\\Project", "win32", { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", OPENAI_API_KEY: "secret", NODE_OPTIONS: "--require malware", BASH_ENV: "bad" });
  expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.BASH_ENV).toBeUndefined();
  expect(env.SystemRoot).toBe("C:\\Windows"); expect(env.TEMP).toBe("C:\\Project\\.stick\\tmp");
});
it("passes exact commands to the selected shell without loading user profiles", () => {
  const command = 'Write-Output "a & b"';
  const args = shellArguments("C:\\Program Files\\PowerShell\\7\\pwsh.exe", command, "win32");
  expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(command);
  expect(shellArguments("/bin/zsh", command, "darwin")).toEqual(["-f", "-c", command]);
  expect(shellArguments("/bin/bash", command, "linux")).toEqual(["--noprofile", "--norc", "-c", command]);
  expect(shellArguments("C:\\Windows\\System32\\cmd.exe", "echo ok", "win32")).toEqual(["/d", "/s", "/c", '"echo ok"']);
});
it(`${process.platform} enforces host confinement or explicitly asserts its warning`, async () => {
  const box = await fixture(); const outside = join(await mkdtemp(join(tmpdir(), "stick-outside-")), "sentinel");
  roots.push(join(outside, "..")); await writeFile(outside, "unchanged");
  const backend = await detectBackend(box);
  if (!backend.isolated) {
    expect(backend.warning).toContain(restrictedWarning);
    expect(shellApproval(backend, box.root, "attempt outside write")).toContain("can read/write outside");
    console.info(`CONFINEMENT WARNING ASSERTED: ${backend.platform} ${backend.warning}`);
    return;
  }
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  const result = await runShell(box, `printf inside > inside.txt; printf escaped > ${quote(outside)}`, new AbortController().signal, backend);
  expect(result).not.toMatch(/^exit=0\n/);
  expect(await readFile(join(box.root, "inside.txt"), "utf8")).toBe("inside");
  expect(await readFile(outside, "utf8")).toBe("unchanged");
}, 20000);
it("runs restricted mode with an explicit cwd on the current platform", async () => {
  const box = await fixture(); const backend = await detectBackend(box);
  const restricted: Backend = { ...backend, name: "restricted", isolated: false, warning: restrictedWarning };
  const command = process.platform === "win32" ? "echo inside>inside.txt" : "printf inside > inside.txt";
  expect(await runShell(box, command, new AbortController().signal, restricted)).toContain("exit=0");
  expect((await readFile(join(box.root, "inside.txt"), "utf8")).trim()).toBe("inside");
}, 20000);
it("timeout terminates a spawned process tree before a delayed outside write", async () => {
  const box = await fixture(); const marker = join(box.root, "should-not-exist");
  const child = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad"), 1800)`;
  const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], {stdio:"inherit"}); setInterval(() => {}, 1000)`;
  await expect(runProcess({ file: process.execPath, args: ["-e", parent], cwd: box.root, env: cleanEnvironment(box.root, process.platform), platform: process.platform }, new AbortController().signal, 500)).rejects.toThrow("exceeded");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await expect(readFile(marker)).rejects.toThrow();
}, 15000);
it("cancellation terminates an active process", async () => {
  const box = await fixture(); const controller = new AbortController();
  const task = runProcess({ file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: box.root, env: {}, platform: process.platform }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await expect(task).rejects.toThrow("cancelled");
}, 10000);
