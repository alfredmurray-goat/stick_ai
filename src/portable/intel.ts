import { cp, mkdir, writeFile, chmod, lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { binaryTarget } from "./build.js";
import { hashFile, staticFiles, verifyStick, type Manifest } from "./integrity.js";
import { llamaRelease, nodeRelease } from "./platform.js";

export interface IntelInputs { app: string; node: string; server: string; lite: string; nodeLicense: string; serverLicense: string; desktopLicenses: string }
export async function buildIntel(project: string, output: string, input: IntelInputs): Promise<Manifest> {
  for (const path of [input.node, input.server, input.lite, input.nodeLicense, input.serverLicense, join(input.app, "Contents/MacOS/stick-ai")]) {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) { throw new Error(`Required release input is unsafe: ${path}`); }
  }
  for (const path of [input.node, input.server, join(input.app, "Contents/MacOS/stick-ai")]) { await binaryTarget(path, "macos-x64"); }
  const handle = await open(input.lite, "r"); const header = Buffer.alloc(8);
  try { await handle.read(header); } finally { await handle.close(); }
  if (header.toString("ascii", 0, 4) !== "GGUF" || ![2, 3].includes(header.readUInt32LE(4))) { throw new Error("Lite input is not GGUF"); }
  try { await lstat(output); throw new Error("Release output already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
  const staging = `${output}.building-${randomUUID()}`;
  try {
    for (const path of ["app/project", "bin/macos-x64", "models", "LICENSES", "logs"]) { await mkdir(join(staging, path), { recursive: true }); }
    for (const name of ["launcher", "stick-verify"]) {
      await build({ entryPoints: [join(project, name === "launcher" ? "src/portable/entry.ts" : "src/portable/verify.ts")], outfile: join(staging, `app/${name}.cjs`), bundle: true, platform: "node", format: "cjs", target: "node24", legalComments: "none", minify: true });
    }
    await writeFile(join(staging, "app/model-templates.json"), JSON.stringify({ "stellan-1-lite": "mistral-v1" }) + "\n");
    await cp(join(project, "portable/ui"), join(staging, "app/ui"), { recursive: true });
    await cp(input.app, join(staging, "Stick AI.app"), { recursive: true, preserveTimestamps: true });
    await cp(input.node, join(staging, "bin/macos-x64/node")); await cp(input.server, join(staging, "bin/macos-x64/llama-server"));
    for (const path of ["bin/macos-x64/node", "bin/macos-x64/llama-server", "Stick AI.app/Contents/MacOS/stick-ai"]) { await chmod(join(staging, path), 0o755); }
    await cp(input.lite, join(staging, "models/stellan-1-lite-q4_k_m.gguf"));
    for (const file of ["LICENSE", "NOTICE", "MODEL_LICENSE.md", "THIRD_PARTY_LICENSES.md"]) { await cp(join(project, file), join(staging, "LICENSES", file)); }
    await cp(join(project, "licenses/Apache-2.0.txt"), join(staging, "LICENSES/Apache-2.0.txt"));
    await cp(input.nodeLicense, join(staging, "LICENSES/Node.txt")); await cp(input.serverLicense, join(staging, "LICENSES/llama.cpp.txt"));
    await cp(input.desktopLicenses, join(staging, "LICENSES/desktop"), { recursive: true });
    const runtime = (await hashFile(join(staging, "bin/macos-x64/node"))).sha256;
    const launcher = (await hashFile(join(staging, "app/launcher.cjs"))).sha256;
    await writeFile(join(staging, "Start.command"), `#!/bin/sh
ROOT=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 1
[ "$(uname -m)" = x86_64 ] || { printf '%s\\n' 'This copy is for Intel Macs; use the copy for your computer.'; exit 1; }
unset NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS NODE_EXTRA_CA_CERTS NODE_DEBUG NODE_USE_ENV_PROXY LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH BASH_ENV ENV
check() { HASH=$(/usr/bin/shasum -a 256 "$1") || return 1; [ "\${HASH%% *}" = "$2" ]; }
check "$ROOT/bin/macos-x64/node" '${runtime}' && check "$ROOT/app/launcher.cjs" '${launcher}' || { printf '%s\\n' 'This copy may be damaged; ask for a fresh copy.'; exit 1; }
exec "$ROOT/bin/macos-x64/node" "$ROOT/app/launcher.cjs" --root "$ROOT" "$@"
`, { mode: 0o755 });
    await writeFile(join(staging, "README.txt"), "STICK AI FOR INTEL MAC\n\nKeep this folder together and double-click Stick AI, then click Start. Nothing needs to be installed. Your Mac needs macOS 13.5 or newer and at least 8 GB of memory.\n\nThe Lite model is included. This copy does not include Max. Your questions and project files stay on this computer. Keep the stick connected while working. Close the app before safely ejecting it.\n\nThis is an unsigned test build. If macOS blocks it, ask the person who supplied it for a signed copy. Do not turn off your Mac's security settings.\n\nStart.command is a technical fallback that opens a terminal and browser. If macOS blocks this, right-click Start and choose Open, once.\n");
    const manifest: Manifest = { format: 1, llamaRelease, nodeRelease, targets: ["macos-x64"], files: [] };
    for (const path of await staticFiles(staging)) {
      const info = await lstat(join(staging, path));
      manifest.files.push({ path, ...await hashFile(join(staging, path)), executable: Boolean(info.mode & 0o111) });
    }
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await verifyStick(staging); await rename(staging, output); return manifest;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
