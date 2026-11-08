import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

export interface PathIO {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; nlink: number }>;
}
export interface PathOptions {
  platform?: NodeJS.Platform;
  caseInsensitive?: boolean;
  io?: PathIO;
}
const nativeIO: PathIO = { realpath, lstat };
export function isInside(root: string, target: string, platform: NodeJS.Platform, insensitive = platform === "win32"): boolean {
  const api = platform === "win32" ? win32 : posix;
  const left = insensitive ? root.toLowerCase() : root;
  const right = insensitive ? target.toLowerCase() : target;
  const rel = platform === "win32" && !insensitive ? posix.relative(left.replaceAll("\\", "/"), right.replaceAll("\\", "/")).replaceAll("/", "\\") : api.relative(left, right);
  return !api.isAbsolute(rel) && rel.split(api.sep)[0] !== "..";
}
export async function resolveProjectPath(root: string, input: string, internal = false, options: PathOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? win32 : posix;
  const io = options.io ?? nativeIO;
  if (input.includes("\0") || api.isAbsolute(input) || win32.isAbsolute(input) || /^[a-z]:/i.test(input) || input.split(/[\\/]/).includes("..")) {
    throw new Error("Use project-relative paths without traversal or drive prefixes");
  }
  if (platform === "win32" && input.split(/[\\/]/).some((part) => /[:<>"|?*]|[. ]$/.test(part) && part !== "." || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Windows device names, streams and ambiguous path components are forbidden");
  }
  const canonicalRoot = await io.realpath(root);
  let existing = api.resolve(canonicalRoot, input);
  const missing: string[] = [];
  let canonical: string;
  while (true) {
    try { canonical = await io.realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
      try {
        if ((await io.lstat(existing)).isSymbolicLink()) { throw new Error("Symlinks must resolve to an existing project target"); }
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code !== "ENOENT") { throw entryError; }
      }
      const parent = api.dirname(existing);
      if (parent === existing) { throw new Error("No existing ancestor for project path"); }
      missing.unshift(api.basename(existing)); existing = parent;
    }
  }
  if (!isInside(canonicalRoot, canonical, platform, options.caseInsensitive)) { throw new Error("Symlinks or paths resolve outside project"); }
  const info = await io.lstat(canonical);
  if (!info.isFile() && !info.isDirectory()) { throw new Error("Special files are forbidden"); }
  if (info.isFile() && info.nlink !== 1) { throw new Error("Hard links are forbidden"); }
  const target = api.resolve(canonical, ...missing);
  if (!isInside(canonicalRoot, target, platform, options.caseInsensitive)) { throw new Error("Path escapes project"); }
  if (!internal && api.relative(canonicalRoot, target).split(api.sep)[0]?.toLowerCase() === ".stick") { throw new Error(".stick is reserved for session state"); }
  return target;
}
export class Sandbox {
  private constructor(readonly root: string, private options: PathOptions) {}
  static async create(root: string): Promise<Sandbox> {
    const canonical = await realpath(root);
    let caseInsensitive = false;
    {
      const alternative = canonical.replace(/[a-zA-Z](?=[^a-zA-Z]*$)/, (letter) => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase());
      try {
        const original = await lstat(canonical);
        const other = await lstat(alternative);
        caseInsensitive = alternative !== canonical && original.dev === other.dev && original.ino === other.ino;
      } catch {}
    }
    return new Sandbox(canonical, { caseInsensitive });
  }
  async path(input: string, internal = false): Promise<string> {
    return resolveProjectPath(this.root, input, internal, this.options);
  }
}
