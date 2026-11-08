import { execFileSync } from "node:child_process";
import { copyFile, mkdir, realpath, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "linux") { throw new Error("Shell runtime requires Linux"); }
const project = await realpath(resolve(process.argv[2] ?? "."));
const runtime = join(project, ".stick/runtime");

const copied = new Set();
async function safeDirectory(path) {
  const relative = path.slice(project.length + 1);
  let current = project;
  for (const part of relative.split("/")) {
    current = join(current, part);
    try {
      if (!(await lstat(current)).isDirectory()) { throw new Error(`Unsafe runtime directory: ${current}`); }
    } catch (error) {
      if (error.code !== "ENOENT") { throw error; }
      await mkdir(current, { mode: 0o700 });
    }
  }
}
async function copy(source, destination = source) {
  const target = join(runtime, destination);
  if (copied.has(target)) { return; }
  copied.add(target);
  await safeDirectory(dirname(target));
  try {
    if (!(await lstat(target)).isFile() || (await lstat(target)).nlink !== 1) { throw new Error(`Unsafe runtime target: ${target}`); }
  } catch (error) { if (error.code !== "ENOENT") { throw error; } }
  await copyFile(await realpath(source), target);
}
await safeDirectory(runtime);
for (const name of ["sh", "ls", "cat", "grep", "find", "mkdir", "rm", "cp", "mv", "touch", "head", "tail", "wc", "sort", "sed", "sleep", "env", "diff"]) {
  const source = await realpath(`/usr/bin/${name}`);
  await copy(source, `/usr/bin/${name}`);
  if (name === "sh") { await copy(source, "/bin/sh"); }
  const libraries = execFileSync("/usr/bin/ldd", [source], { encoding: "utf8" });
  for (const match of libraries.matchAll(/(?:=>\s+)?(\/[^\s()]+)/g)) { await copy(match[1]); }
}
await safeDirectory(join(runtime, "project"));
const ready = join(runtime, ".ready");
try {
  if (!(await lstat(ready)).isFile() || (await lstat(ready)).nlink !== 1) { throw new Error("Unsafe runtime marker"); }
} catch (error) { if (error.code !== "ENOENT") { throw error; } }
await writeFile(ready, "stick_ai runtime 1\n", { mode: 0o600 });
console.log(`Prepared offline shell runtime for ${project}`);
