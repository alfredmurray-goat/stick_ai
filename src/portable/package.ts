import { cp, mkdir, writeFile, chmod, lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { binaryTarget, posixStart, windowsStart } from "./build.js";
import { hashFile, staticFiles, verifyStick, type Manifest } from "./integrity.js";
import { llamaRelease, nodeRelease, executableName, type Target } from "./platform.js";

export interface PlatformInputs { app: string; node: string; server: string; lite: string; nodeLicense: string; serverLicense: string; desktopLicenses: string }
export async function buildPlatform(project: string, output: string, target: Target, input: PlatformInputs): Promise<Manifest> {
  const mac = target.startsWith("macos-");
  const native = mac ? join(input.app, "Contents/MacOS/stick-ai") : input.app;
  const desktop = mac ? "Stick AI.app" : target === "windows-x64" ? "Stick AI.exe" : "stick-ai";
  const node = `bin/${target}/${executableName(target, true)}`;
  const server = `bin/${target}/${executableName(target)}`;
  for (const path of [input.node, input.server, input.lite, input.nodeLicense, input.serverLicense, native]) {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) { throw new Error(`Required release input is unsafe: ${path}`); }
  }
  for (const path of [input.node, input.server, native]) { await binaryTarget(path, target); }
  const handle = await open(input.lite, "r"); const header = Buffer.alloc(8);
  try { await handle.read(header); } finally { await handle.close(); }
  if (header.toString("ascii", 0, 4) !== "GGUF" || ![2, 3].includes(header.readUInt32LE(4))) { throw new Error("Lite input is not GGUF"); }
  try { await lstat(output); throw new Error("Release output already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
  const staging = `${output}.building-${randomUUID()}`;
  try {
    for (const path of ["app/project", `bin/${target}`, "models", "LICENSES", "logs"]) { await mkdir(join(staging, path), { recursive: true }); }
    for (const name of ["launcher", "stick-verify", "stick-update"]) {
      await build({ entryPoints: [join(project, name === "launcher" ? "src/portable/entry.ts" : name === "stick-update" ? "src/portable/update-entry.ts" : "src/portable/verify.ts")], outfile: join(staging, `app/${name}.cjs`), bundle: true, platform: "node", format: "cjs", target: "node24", legalComments: "none", minify: true });
    }
    await writeFile(join(staging, "app/update-config.json"), JSON.stringify({ format: 1, repository: "alfredmurray-goat/stick_ai", target, sequence: Number(process.env.GITHUB_RUN_ID ?? 0), source: process.env.GITHUB_SHA ?? "development" }) + "\n");
    await writeFile(join(staging, "app/model-templates.json"), JSON.stringify({ "stellan-1-lite": "mistral-v1" }) + "\n");
    await cp(join(project, "portable/ui"), join(staging, "app/ui"), { recursive: true });
    await cp(input.app, join(staging, desktop), { recursive: true, preserveTimestamps: true });
    await cp(input.node, join(staging, node)); await cp(input.server, join(staging, server));
    for (const path of [node, server, mac ? `${desktop}/Contents/MacOS/stick-ai` : desktop]) { await chmod(join(staging, path), 0o755); }
    await cp(input.lite, join(staging, "models/stellan-1-lite-q4_k_m.gguf"));
    for (const file of ["LICENSE", "NOTICE", "MODEL_LICENSE.md", "THIRD_PARTY_LICENSES.md"]) { await cp(join(project, file), join(staging, "LICENSES", file)); }
    await cp(join(project, "licenses/Apache-2.0.txt"), join(staging, "LICENSES/Apache-2.0.txt"));
    await cp(input.nodeLicense, join(staging, "LICENSES/Node.txt")); await cp(input.serverLicense, join(staging, "LICENSES/llama.cpp.txt"));
    await cp(input.desktopLicenses, join(staging, "LICENSES/desktop"), { recursive: true });
    const runtime = (await hashFile(join(staging, node))).sha256;
    const launcher = (await hashFile(join(staging, "app/launcher.cjs"))).sha256;
    const hashes = { "macos-arm64": runtime, "macos-x64": runtime, "windows-x64": runtime, "linux-x64": runtime };
    const fallback = mac ? "Start.command" : target === "windows-x64" ? "Start.bat" : "start.sh";
    await writeFile(join(staging, fallback), target === "windows-x64" ? windowsStart(runtime, launcher) : posixStart(mac, hashes, launcher), { mode: 0o755 });
    const requirement = mac ? "macOS 13.5 or newer" : target === "windows-x64" ? "Windows 10 or newer with Microsoft Edge WebView2 already available" : "Linux x64 with glibc 2.35 or newer, GTK 3 and WebKitGTK 4.1 already available";
    await writeFile(join(staging, "README.txt"), `YOUR PRIVATE ASSISTANT\n\nKeep this folder together and open ${desktop}, then click Start. Your computer needs ${requirement} and at least 8 GB of memory.\n\nLite is included. Max is not included in this download. Your questions and project files stay on this computer. Keep the stick connected. Close the app before safely ejecting it.\n\nThis is an unsigned test build. If your computer blocks it, ask the person who supplied it for a signed copy. Do not turn off security settings.\n\n${fallback} is a fallback for technical users that opens a terminal and a browser. If the desktop cannot open, ask the person who supplied this copy for help.\nIf macOS blocks this, right-click Start and choose Open, once.\nIf Windows blocks the fallback, choose More info and Run anyway only if you trust this stick.\n`);
    const manifest: Manifest = { format: 1, llamaRelease, nodeRelease, targets: [target], files: [] };
    for (const path of await staticFiles(staging)) {
      const info = await lstat(join(staging, path));
      manifest.files.push({ path, ...await hashFile(join(staging, path)), executable: Boolean(info.mode & 0o111) });
    }
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await verifyStick(staging); await rename(staging, output); return manifest;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
