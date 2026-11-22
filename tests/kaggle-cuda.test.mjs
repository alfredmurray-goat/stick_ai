import { expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execute = promisify(execFile);
const notebook = JSON.parse(await readFile(new URL("../docs/benchmark/kaggle-max-humaneval.ipynb", import.meta.url), "utf8"));
const cell = notebook.cells.find((item) => item.cell_type === "code" && item.source.join("").startsWith("%%bash")).source.join("");
const build = cell.slice(cell.indexOf("CUDA_FLAGS=("), cell.indexOf('\necho "== Stellan-1 Max'));
const sha = cell.match(/^LLAMA_COMMIT=([a-f0-9]{40})$/m)[1];
const posix = it.skipIf(process.platform === "win32");

async function fixture(gpu, hideDevices = false) {
  const root = await mkdtemp(join(tmpdir(), "kaggle CUDA fixture "));
  const bin = join(root, "fixture-bin"); await mkdir(bin);
  await mkdir(join(root, "stick_ai/scripts"), { recursive: true });
  await writeFile(join(root, "stick_ai/scripts/llama-split-dir.patch"), "fixture patch\n");
  const mock = join(bin, "command.mjs");
  await writeFile(mock, [
    'import { createHash } from "node:crypto";',
    'import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";',
    'import { join } from "node:path";',
    'const [role, ...args] = process.argv.slice(2);',
    'const root = process.env.WORK;',
    'if (role === "git") {',
    '  appendFileSync(join(root, "git.calls"), JSON.stringify(args) + "\\n");',
    '  if (args.includes("rev-parse")) { console.log(process.env.MOCK_SHA); }',
    '} else if (role === "sha256sum") {',
    '  console.log(createHash("sha256").update(readFileSync(args[0])).digest("hex") + "  " + args[0]);',
    '} else if (role === "nproc") { console.log("2"); }',
    'else if (role === "cmake") {',
    '  appendFileSync(join(root, "cmake.calls"), JSON.stringify(args) + "\\n");',
    '  if (args[0] === "--build") {',
    '    const folder = join(root, args[1], "bin"); mkdirSync(folder, { recursive: true });',
    '    const devices = process.env.MOCK_HIDE === "1" ? "CPU: fixture" : "CUDA0: Tesla T4\\nCUDA1: Tesla T4";',
    '    writeFileSync(join(folder, "llama-server"), "#!/bin/sh\\nprintf \'%s\\\\n\' \'" + devices + "\'\\n", { mode: 0o755 });',
    '  } else {',
    '    if (args.includes("-DGGML_CUDA=ON") && !args.includes("-DGGML_CUDA_NO_VMM=ON")) {',
    '      console.error("Target ggml-cuda links to CUDA::cuda_driver but the target was not found"); process.exit(1);',
    '    }',
    '    mkdirSync(join(root, args[args.indexOf("-B") + 1]), { recursive: true });',
    '  }',
    '}'
  ].join("\n"));
  for (const name of ["git", "cmake", "nvcc", "nproc", "sha256sum"]) {
    const path = join(bin, name);
    await writeFile(path, "#!/bin/sh\nexec '" + process.execPath + "' '" + mock + "' '" + name + "' \"$@\"\n");
    await chmod(path, 0o755);
  }
  await mkdir(join(root, "llama-build/bin"), { recursive: true });
  await writeFile(join(root, "llama-build/bin/llama-server"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const script = join(root, "build.sh");
  await writeFile(script, 'set -euo pipefail\ncd "$WORK"\n' + build + '\nprintf \'%s\\n\' "$SERVER" > server.path\n');
  return {
    root,
    run: () => execute("bash", [script], { env: { ...process.env, WORK: root, GPU: String(gpu), LLAMA_COMMIT: sha, MOCK_SHA: sha, MOCK_HIDE: hideDevices ? "1" : "0", PATH: bin + ":" + process.env.PATH }, timeout: 20000 }),
    async configure() { return JSON.parse((await readFile(join(root, "cmake.calls"), "utf8")).trim().split("\n")[0]); },
    close: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  };
}

posix("builds CUDA without the missing driver-link target and ignores a stale CPU server", async () => {
  const f = await fixture(1);
  try {
    const result = await f.run(); const flags = await f.configure();
    expect(flags).toContain("-DGGML_CUDA=ON"); expect(flags).toContain("-DGGML_CUDA_NO_VMM=ON"); expect(flags).toContain("-DCMAKE_CUDA_ARCHITECTURES=75");
    expect(result.stdout).toContain("CUDA1: Tesla T4");
    const server = (await readFile(join(f.root, "server.path"), "utf8")).trim();
    expect(dirname(dirname(server))).toContain("cuda-sm75-no-vmm"); expect(server).not.toBe(join(f.root, "llama-build/bin/llama-server"));
    const calls = (await readFile(join(f.root, "git.calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.some((args) => args.includes("fetch") && args.at(-1) === sha)).toBe(true);
    expect(calls.some((args) => args.includes("apply") && args.at(-1).endsWith("llama-split-dir.patch"))).toBe(true);
  } finally { await f.close(); }
}, 30000);

posix("stops a requested GPU benchmark if the server exposes only CPU devices", async () => {
  const f = await fixture(1, true);
  try { await expect(f.run()).rejects.toMatchObject({ stdout: expect.stringContaining("server has no CUDA devices") }); await expect(readFile(join(f.root, "server.path"))).rejects.toThrow(); }
  finally { await f.close(); }
}, 30000);

posix("keeps an explicitly CPU-only run separate with CUDA disabled", async () => {
  const f = await fixture(0);
  try { await f.run(); expect(await f.configure()).toContain("-DGGML_CUDA=OFF"); expect(await readFile(join(f.root, "server.path"), "utf8")).toContain("-cpu/bin/llama-server"); }
  finally { await f.close(); }
}, 30000);
