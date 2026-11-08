import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, isAbsolute, join, win32 } from "node:path";
import { runProcess, type ProcessSpec } from "./process.js";
import type { Sandbox } from "./paths.js";

export type BackendName = "sandbox-exec" | "bubblewrap" | "restricted";
export interface Backend {
  platform: NodeJS.Platform;
  name: BackendName;
  shell: string;
  isolated: boolean;
  warning?: string;
}
export interface Detection {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: (path: string) => Promise<boolean>;
  probe?: (backend: Backend) => Promise<void>;
}
export const restrictedWarning = "WARNING: restricted mode is NOT an OS sandbox. Commands can read/write outside the project and use the network with your account permissions. Only cwd and environment are restricted; approve trusted commands only. Process-tree cleanup is best effort without a Windows Job Object or against detached POSIX processes.";
const executable = async (path: string): Promise<boolean> => {
  try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
};
export function shellArguments(shell: string, command: string, platform: NodeJS.Platform): string[] {
  const name = (platform === "win32" ? win32 : { basename }).basename(shell).toLowerCase();
  if (platform === "win32") {
    if (name === "cmd.exe") { return ["/d", "/s", "/c", `"${command}"`]; }
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
  }
  if (name === "zsh") { return ["-f", "-c", command]; }
  if (name === "bash") { return ["--noprofile", "--norc", "-c", command]; }
  return ["-c", command];
}
export function cleanEnvironment(root: string, platform: NodeJS.Platform, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const api = platform === "win32" ? win32 : { join, delimiter };
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? source.Path ?? (platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin"),
    HOME: root, USERPROFILE: root, TMPDIR: api.join(root, ".stick", "tmp"),
    TMP: api.join(root, ".stick", "tmp"), TEMP: api.join(root, ".stick", "tmp"),
    LANG: "C.UTF-8"
  };
  if (platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const actual = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (actual && source[actual]) { env[key] = source[actual]; }
    }
  }
  return env;
}
function literal(path: string): string { return JSON.stringify(path); }
export function macProfile(root: string): string {
  const system = ["/System", "/usr", "/bin", "/sbin", "/Library/Developer", "/Library/Apple", "/opt/homebrew", "/opt/local", "/private/var/db/dyld", "/private/var/db/timezone", "/private/etc/ssl", "/private/etc/paths.d"];
  return [
    "(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)",
    "(allow file-read-metadata)",
    "(allow mach-lookup (global-name \"com.apple.system.logger\"))",
    `(allow file-read* ${system.map((path) => `(subpath ${literal(path)})`).join(" ")})`,
    "(allow file-read* (literal \"/\") (literal \"/dev/null\") (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/private/etc/localtime\") (literal \"/private/etc/zshenv\"))",
    `(allow file-read* file-write* (require-all (subpath ${literal(root)}) (require-not (subpath ${literal(join(root, ".stick"))}))))`,
    `(allow file-read* file-write* (subpath ${literal(join(root, ".stick", "tmp"))}))`,
    "(allow file-write* (literal \"/dev/null\"))", "(deny network*)"
  ].join("\n");
}
export function processSpec(backend: Backend, root: string, command: string): ProcessSpec {
  const env = cleanEnvironment(root, backend.platform);
  const args = shellArguments(backend.shell, command, backend.platform);
  if (backend.name === "sandbox-exec") {
    return { file: "/usr/bin/sandbox-exec", args: ["-p", macProfile(root), backend.shell, ...args], cwd: root, env, platform: backend.platform };
  }
  if (backend.name === "bubblewrap") {
    const mounts = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/nix", "/etc/ld.so.cache", "/etc/alternatives"];
    return {
      file: "/usr/bin/bwrap",
      args: ["--unshare-all", "--die-with-parent", "--cap-drop", "ALL", ...mounts.flatMap((path) => ["--ro-bind-try", path, path]), "--proc", "/proc", "--dev", "/dev", "--bind", root, root, "--tmpfs", join(root, ".stick"), "--dir", join(root, ".stick", "tmp"), "--bind", join(root, ".stick", "tmp"), join(root, ".stick", "tmp"), "--remount-ro", join(root, ".stick"), "--chdir", root, backend.shell, ...args],
      cwd: root, env, platform: backend.platform
    };
  }
  return { file: backend.shell, args, cwd: root, env, platform: backend.platform, verbatim: backend.platform === "win32" && win32.basename(backend.shell).toLowerCase() === "cmd.exe" };
}
export async function detectBackend(box: Sandbox, options: Detection = {}): Promise<Backend> {
  const platform = options.platform ?? process.platform;
  if (!["linux", "darwin", "win32"].includes(platform)) { throw new Error(`Unsupported platform: ${platform}`); }
  const env = options.env ?? process.env;
  const exists = options.executable ?? executable;
  const api = platform === "win32" ? win32 : { basename, isAbsolute, delimiter, join };
  const selected = env.STICK_SHELL ?? (platform === "win32" ? env.ComSpec ?? env.COMSPEC ?? "cmd.exe" : env.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/bash"));
  const allowed = platform === "win32" ? ["cmd.exe", "powershell.exe", "pwsh.exe"] : ["bash", "zsh", "sh"];
  if (!allowed.includes(api.basename(selected).toLowerCase())) { throw new Error("STICK_SHELL must select bash, zsh, sh, PowerShell or cmd for this platform"); }
  let shell = selected;
  if (!api.isAbsolute(shell)) {
    const candidates = (env.PATH ?? env.Path ?? "").split(api.delimiter).filter((directory) => api.isAbsolute(directory)).map((directory) => api.join(directory, selected));
    const found = await Promise.all(candidates.map(async (candidate) => await exists(candidate) ? candidate : undefined));
    const match = found.find(Boolean);
    if (!match) { throw new Error(`Cannot locate default shell: ${selected}. Set STICK_SHELL to an absolute executable path.`); }
    shell = match;
  }
  if (!await exists(shell)) { throw new Error(`Shell is unavailable: ${shell}`); }
  const name: BackendName = platform === "darwin" ? "sandbox-exec" : platform === "linux" ? "bubblewrap" : "restricted";
  const candidate: Backend = { platform, name, shell, isolated: name !== "restricted" };
  const binary = name === "sandbox-exec" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap";
  let reason = platform === "win32" ? "Windows has no native Job Object backend in this build." : `${name} is missing.`;
  if (name !== "restricted" && await exists(binary)) {
    try {
      if (options.probe) { await options.probe(candidate); }
      else {
        const spec = processSpec(candidate, box.root, "exit 0");
        await mkdir(await box.path(".stick/tmp", true), { recursive: true, mode: 0o700 });
        const result = await runProcess(spec, new AbortController().signal, 3000);
        if (!result.startsWith("exit=0\n")) { throw new Error(result.slice(0, 400)); }
      }
      return candidate;
    } catch (error) { reason = `${name} capability probe failed: ${String(error).slice(0, 400)}`; }
  }
  return { platform, name: "restricted", shell, isolated: false, warning: `${reason} ${restrictedWarning}` };
}
export function shellApproval(backend: Backend, root: string, command: string): string {
  return `run_shell\nCommand (JSON, lossless): ${JSON.stringify(command)}\nWorking directory: ${root}\nSandbox backend: ${backend.name} (${backend.platform})${backend.warning ? `\n${backend.warning}` : ""}`;
}
