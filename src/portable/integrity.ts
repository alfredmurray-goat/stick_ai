import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Sandbox } from "../sandbox/paths.js";
import { UserError, llamaRelease, nodeRelease, targets, type Target } from "./platform.js";

export interface FileRecord { path: string; sha256: string; size: number; executable: boolean; optional?: boolean }
export interface Manifest { format: 1; llamaRelease: string; nodeRelease: string; targets?: Target[]; files: FileRecord[] }
export async function hashFile(path: string, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) { size += chunk.length; hash.update(chunk); }
  return { sha256: hash.digest("hex"), size };
}
export async function staticFiles(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    if ([".DS_Store", "Thumbs.db", "desktop.ini", ".Spotlight-V100", ".Trashes", ".fseventsd", "System Volume Information", "$RECYCLE.BIN"].includes(item.name) || item.name.startsWith("._")) { continue; }
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (path === "logs" || path === "app/project" || path === "manifest.json") { continue; }
    if (item.isSymbolicLink() || !item.isDirectory() && !item.isFile()) { throw new UserError("damaged"); }
    if (item.isDirectory()) { result.push(...await staticFiles(root, path)); } else { result.push(path); }
  }
  return result.sort();
}
export async function verifyStick(root: string, optionalMax = false, signal?: AbortSignal): Promise<Manifest> {
  try {
    const canonical = await realpath(root);
    const box = await Sandbox.create(root);
    await box.path("logs", true); await box.path("app/project", true);
    const manifestInfo = await lstat(join(root, "manifest.json"));
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 4000000) { throw new UserError("damaged"); }
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
    if (manifest.format !== 1 || manifest.llamaRelease !== llamaRelease || manifest.nodeRelease !== nodeRelease || !Array.isArray(manifest.files)) { throw new UserError("damaged"); }
    const selected = manifest.targets ?? [...targets];
    if (!Array.isArray(selected) || !selected.length || selected.some((target) => !targets.includes(target)) || new Set(selected).size !== selected.length) { throw new UserError("damaged"); }
    const launchers = [...new Set(selected.map((target) => target.startsWith("macos-") ? "Start.command" : target === "windows-x64" ? "Start.bat" : "start.sh"))];
    const expected = new Set<string>();
    const issues: string[] = [];
    for (const record of manifest.files) {
      if (typeof record.path !== "string" || !record.path || record.path.split("/").some((part) => !part || part === "." || part === "..") || /[\\:]/.test(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.executable !== "boolean" || !Number.isSafeInteger(record.size) || record.size < 0 || expected.has(record.path)) { throw new UserError("damaged"); }
      expected.add(record.path);
      const path = join(root, record.path);
      try {
      let info;
      try { info = await lstat(path); } catch (error) {
        if (optionalMax && record.optional && record.path === "models/stellan-1-max-q4_k_m.gguf" && (error as NodeJS.ErrnoException).code === "ENOENT") { continue; }
        throw error;
      }
      const resolved = await realpath(path);
      const rel = relative(canonical, resolved);
      if (rel.split(sep)[0] === ".." || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) { throw new UserError("damaged"); }
      const actual = await hashFile(path, signal);
      if (actual.sha256 !== record.sha256 || actual.size !== record.size || process.platform !== "win32" && record.executable && !(info.mode & 0o111)) { issues.push(`Changed file: ${record.path}`); }
      } catch (error) { if (signal?.aborted) { throw error; } issues.push(`Missing or unsafe file: ${record.path}: ${String(error)}`); }
    }
    for (const path of await staticFiles(root)) { if (!expected.has(path)) { issues.push(`Unlisted or missing file: ${path}`); } }
    for (const path of [...launchers, "README.txt", "app/launcher.cjs", "app/ui/index.html", "app/ui/main.js", "app/ui/style.css", "models/stellan-1-lite-q4_k_m.gguf", ...selected.flatMap((target) => [`bin/${target}/node${target === "windows-x64" ? ".exe" : ""}`, `bin/${target}/llama-server${target === "windows-x64" ? ".exe" : ""}`])]) {
      if (!expected.has(path)) { issues.push(`Unlisted or missing file: ${path}`); }
    }
    if (issues.length) { const error = new UserError("damaged"); error.message = `damaged: ${issues.join("; ")}`; throw error; }
    return manifest;
  } catch (error) { if (error instanceof UserError) { throw error; } const failure = new UserError("damaged"); failure.message = `damaged: ${String(error)}`; throw failure; }
}
