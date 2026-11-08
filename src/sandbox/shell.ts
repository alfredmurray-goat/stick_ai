import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { Sandbox } from "./paths.js";
import { detectBackend, processSpec, type Backend } from "./backends.js";
import { runProcess } from "./process.js";

export async function runShell(box: Sandbox, command: string, signal: AbortSignal, selected?: Backend): Promise<string> {
  signal.throwIfAborted();
  const backend = selected ?? await detectBackend(box);
  const root = await box.path(".", true);
  if (await realpath(root) !== box.root) { throw new Error("Project working directory changed"); }
  const inspect = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      signal.throwIfAborted();
      const child = join(path, entry.name);
      await box.path(relative(root, child), true);
      if (entry.isDirectory()) { await inspect(child); }
      if (entry.isFile() && (await lstat(child)).nlink !== 1) { throw new Error("Shell refused: project contains hard links"); }
    }
  };
  await inspect(root);
  await mkdir(await box.path(".stick/tmp", true), { recursive: true, mode: 0o700 });
  const spec = processSpec(backend, root, command);
  const result = await runProcess(spec, signal);
  return `${backend.warning ? `${backend.warning}\n` : ""}${result}`;
}
