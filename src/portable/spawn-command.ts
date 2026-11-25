import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { extname, win32 } from "node:path";

// Starts an MCP program the way a terminal would, without a shell and without a third-party package.
// macOS and Linux: Node's spawn already does this. Windows needs care: commands such as `npx` are
// batch files (npx.cmd), which Node refuses to start directly (CVE-2024-27980), so they run through
// cmd.exe with every argument quoted and escaped so cmd.exe can't read any of it as an instruction.
// The current folder is never searched (a project could plant a fake `npx.cmd` there).

const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;
// A program's arguments as CommandLineToArgvW reads them: quotes around the whole argument, quotes
// inside escaped with a backslash, and backslashes doubled only where they come before a quote.
export function quoteWindowsArgument(value: string): string {
  let result = "\"";
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") { slashes++; continue; }
    if (character === "\"") { result += "\\".repeat(slashes * 2 + 1) + "\""; }
    else { result += "\\".repeat(slashes) + character; }
    slashes = 0;
  }
  return result + "\\".repeat(slashes * 2) + "\"";
}
/** Escapes text for cmd.exe: every special character gets a caret, so cmd.exe treats it as plain text. */
export function caretEscape(value: string): string { return value.replace(cmdMeta, "^$1"); }
/**
 * The cmd.exe command line for running a batch file with these arguments. Batch files such as npm's
 * `npx.cmd` hand their arguments (`%*`) to cmd.exe a second time, so each argument gets two rounds of
 * carets: one for `cmd /c`, one for the batch file's own line. With only one round, an argument holding
 * a quote can end the quoting early and let a later `&` run a command. The file name is read once.
 */
export function windowsBatchCommandLine(file: string, args: readonly string[]): string {
  return [caretEscape(file), ...args.map((value) => caretEscape(caretEscape(quoteWindowsArgument(value))))].join(" ");
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}
const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
/** Finds the file Windows would run for `command`, using PATH and PATHEXT but never the current folder. */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = isFile): string | undefined {
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.trim()).filter(Boolean);
  const candidates = (base: string): string[] => {
    const ext = extname(base).toLowerCase();
    return ext && extensions.some((value) => value.toLowerCase() === ext) ? [base] : extensions.map((value) => base + value.toLowerCase());
  };
  if (/[\\/]/.test(command) || win32.isAbsolute(command)) {
    if (!win32.isAbsolute(command)) { return undefined; }
    return candidates(command).find(exists);
  }
  for (const folder of (envValue(env, "PATH") ?? "").split(";").map((value) => value.trim().replace(/^"(.*)"$/, "$1")).filter((value) => value && win32.isAbsolute(value))) {
    const found = candidates(win32.join(folder, command)).find(exists);
    if (found) { return found; }
  }
  return undefined;
}

export interface CommandPlan { file: string; args: string[]; verbatim: boolean }
/** What would actually be started, without starting it (also used by the tests). */
export function planCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, exists?: (path: string) => boolean): CommandPlan {
  if (platform !== "win32") { return { file: command, args: [...args], verbatim: false }; }
  const resolved = resolveWindowsCommand(command, env, exists);
  if (!resolved) { return { file: command, args: [...args], verbatim: false }; }
  if (!/\.(cmd|bat)$/i.test(resolved)) { return { file: resolved, args: [...args], verbatim: false }; }
  const shell = envValue(env, "ComSpec") ?? "cmd.exe";
  return { file: shell, args: ["/d", "/s", "/c", `"${windowsBatchCommandLine(resolved, args)}"`], verbatim: true };
}

/** Like child_process.spawn, but finds and safely starts Windows batch commands such as `npx`. */
export function spawnCommand(command: string, args: readonly string[], options: SpawnOptions & { env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const plan = planCommand(command, args, options.env ?? process.env);
  return spawn(plan.file, plan.args, { ...options, shell: false, ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}) });
}
