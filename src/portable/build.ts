import { cp, mkdir, readFile, writeFile, chmod, lstat, readdir, rename, rm, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { hashFile, staticFiles, type Manifest } from "./integrity.js";
import { executableName, llamaRelease, modelFile, nodeRelease, targets, type Target } from "./platform.js";

export interface StickInputs {
  servers: Record<Target, string>;
  nodes: Record<Target, string>;
  nodeLicenses: Record<Target, string>;
  desktop?: Record<Target, string>;
  desktopLicenses?: string;
  support?: Partial<Record<Target, string>>;
  lite: string;
  max: string;
}
async function regular(path: string): Promise<void> {
  if (!path || !(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) { throw new Error(`Required input is not a regular file: ${path}`); }
}
export async function binaryTarget(path: string, target: Target): Promise<void> {
  const handle = await open(path, "r"); const data = Buffer.alloc(4096);
  try { await handle.read(data); } finally { await handle.close(); }
  const valid = target === "linux-x64" ? data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && data[4] === 2 && data.readUInt16LE(18) === 62 : target === "windows-x64" ? data.toString("ascii", 0, 2) === "MZ" && data.readUInt32LE(60) < 4000 && data.toString("ascii", data.readUInt32LE(60), data.readUInt32LE(60) + 4) === "PE\0\0" && data.readUInt16LE(data.readUInt32LE(60) + 4) === 0x8664 : data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === (target === "macos-arm64" ? 0x100000c : 0x1000007);
  if (!valid) { throw new Error(`Input does not match ${target}: ${path}. Supply a thin 64-bit executable for that target.`); }
}
async function gguf(path: string): Promise<void> {
  const handle = await open(path, "r"); const header = Buffer.alloc(8);
  try { await handle.read(header); } finally { await handle.close(); }
  if (header.toString("ascii", 0, 4) !== "GGUF" || ![2, 3].includes(header.readUInt32LE(4))) { throw new Error(`Input is not a GGUF model: ${path}`); }
}
const damaged = "This stick may be damaged; ask for a fresh copy.";
function posixStart(mac: boolean, hashes: Record<Target, string>, appHash: string): string {
  return `#!/bin/sh
ROOT=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 1
if [ -L "$ROOT/logs" ] || [ -L "$ROOT/logs/launcher.log" ]; then printf '%s\\n' 'This stick may be damaged; ask for a fresh copy.'; exit 1; fi
mkdir -p "$ROOT/logs" 2>/dev/null || { printf '%s\\n' 'The stick cannot save its files; unlock the stick and try again.'; exit 1; }
if [ -e "$ROOT/logs/launcher.log" ]; then
  LINKS=$(${mac ? "/usr/bin/stat -f %l" : "/usr/bin/stat -c %h"} "$ROOT/logs/launcher.log" 2>/dev/null)
  [ "$LINKS" = 1 ] || { printf '%s\\n' '${damaged}'; exit 1; }
fi
if ! ( : >>"$ROOT/logs/launcher.log" ) 2>/dev/null; then printf '%s\\n' 'The stick cannot save its files; unlock the stick and try again.'; exit 1; fi
unset NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS NODE_EXTRA_CA_CERTS NODE_REPL_HISTORY NODE_DEBUG NODE_USE_ENV_PROXY SSLKEYLOGFILE LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH BASH_ENV ENV
${mac ? 'case "$(uname -m)" in arm64) TARGET=macos-arm64; EXPECTED='+hashes['macos-arm64']+';; x86_64) TARGET=macos-x64; EXPECTED='+hashes['macos-x64']+';; *) printf "%s\\n" "This computer is not supported; try another computer."; exit 1;; esac' : 'case "$(uname -m)" in x86_64) TARGET=linux-x64; EXPECTED='+hashes['linux-x64']+';; *) printf "%s\\n" "This computer is not supported; try another computer."; exit 1;; esac'}
check() {
  if command -v sha256sum >/dev/null 2>&1; then HASH=$(sha256sum "$1" 2>>"$ROOT/logs/launcher.log"); elif command -v shasum >/dev/null 2>&1; then HASH=$(shasum -a 256 "$1" 2>>"$ROOT/logs/launcher.log"); else return 1; fi
  [ "\${HASH%% *}" = "$2" ]
}
NODE="$ROOT/bin/$TARGET/node"
check "$NODE" "$EXPECTED" && check "$ROOT/app/launcher.cjs" '${appHash}' || { printf '%s\\n' '${damaged}'; exit 1; }
"$NODE" "$ROOT/app/launcher.cjs" --root "$ROOT" "$@" 2>>"$ROOT/logs/launcher.log"
RESULT=$?
[ "$RESULT" = 0 ] || printf '%s\\n' 'The assistant could not start; close other apps and try again.'
exit "$RESULT"
`;
}
function windowsStart(nodeHash: string, appHash: string): string {
  return `@echo off\r
setlocal DisableDelayedExpansion\r
set "ROOT=%~dp0"\r
"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command "try { foreach ($p in @($env:ROOT+'logs', $env:ROOT+'logs\\launcher.log')) { if (Test-Path -LiteralPath $p) { $i = Get-Item -LiteralPath $p -Force; if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $i.LinkType -eq 'HardLink') { exit 1 } } } } catch { exit 1 }" >nul 2>nul\r
if errorlevel 1 goto damaged\r
if not exist "%ROOT%logs" mkdir "%ROOT%logs" 2>nul\r
set "NODE_OPTIONS="\r
set "NODE_PATH="\r
set "NODE_V8_COVERAGE="\r
set "NODE_COMPILE_CACHE="\r
set "NODE_REDIRECT_WARNINGS="\r
set "NODE_EXTRA_CA_CERTS="\r
set "NODE_REPL_HISTORY="\r
set "NODE_DEBUG="\r
set "NODE_USE_ENV_PROXY="\r
set "STICK_NODE=%ROOT%bin\\windows-x64\\node.exe"\r
set "STICK_APP=%ROOT%app\\launcher.cjs"\r
set "STICK_NODE_HASH=${nodeHash}"\r
set "STICK_APP_HASH=${appHash}"\r
if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto supported\r
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto supported\r
echo This computer is not supported; try another computer.\r
exit /b 1\r
:supported\r
"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command "try { if ((Get-FileHash -LiteralPath $env:STICK_NODE -Algorithm SHA256).Hash -ne $env:STICK_NODE_HASH -or (Get-FileHash -LiteralPath $env:STICK_APP -Algorithm SHA256).Hash -ne $env:STICK_APP_HASH) { exit 1 } } catch { exit 1 }" 2>>"%ROOT%logs\\launcher.log"\r
if errorlevel 1 goto damaged\r
"%STICK_NODE%" "%STICK_APP%" --root "%ROOT%." %* 2>>"%ROOT%logs\\launcher.log"\r
if not errorlevel 1 exit /b 0\r
echo If Windows blocked the assistant, choose More info and Run anyway only if you trust this stick.\r
pause >nul\r
exit /b 1\r
:damaged\r
echo ${damaged}\r
pause >nul\r
exit /b 1\r
`;
}
export const userReadme = `YOUR PRIVATE ASSISTANT

Open the desktop folder, open the folder for your computer, and double-click Stick AI on Mac, stick-ai.exe on Windows, or stick-ai on Linux. Click Start.

Everything runs on this computer. Lite starts automatically. On computers with at least 16 GB of memory, a larger assistant can help with coding, one model at a time.

Keep the stick connected. Close the app before safely ejecting it.

If your computer blocks the app, ask the person who supplied the stick for a signed copy.

Start.command, Start.bat and start.sh are fallbacks for technical users; they open a terminal and a browser.
If macOS blocks this, right-click Start and choose Open, once.
If Windows blocks the fallback, choose More info and Run anyway only if you trust this stick.

Some computers need a system update before the desktop app can open; ask the person who supplied the stick for help.\n`;
export async function buildStick(project: string, output: string, inputs: StickInputs): Promise<Manifest> {
  const sources = [...targets.flatMap((target) => [inputs.servers[target], inputs.nodes[target], inputs.nodeLicenses[target]]), inputs.lite, inputs.max];
  for (const path of sources) { await regular(path); }
  for (const target of targets) { await binaryTarget(inputs.servers[target], target); await binaryTarget(inputs.nodes[target], target); }
  if (inputs.desktop) {
    for (const target of targets) {
      const input = inputs.desktop[target];
      const executable = target.startsWith("macos-") ? join(input, "Contents", "MacOS", "stick-ai") : input;
      await regular(executable); await binaryTarget(executable, target);
    }
    if (!inputs.desktopLicenses || !(await lstat(inputs.desktopLicenses)).isDirectory()) { throw new Error("Desktop dependency licence directory is required"); }
  }
  await gguf(inputs.lite); await gguf(inputs.max);
  try { await lstat(output); throw new Error(`Output already exists: ${output}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
  const staging = `${output}.building-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    await mkdir(join(staging, "app", "project"), { recursive: true }); await mkdir(join(staging, "models")); await mkdir(join(staging, "LICENSES")); await mkdir(join(staging, "logs"));
    await build({ entryPoints: [join(project, "src/portable/entry.ts")], outfile: join(staging, "app/launcher.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", legalComments: "none", minify: true });
    await build({ entryPoints: [join(project, "src/portable/verify.ts")], outfile: join(staging, "app/stick-verify.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", legalComments: "none", minify: true });
    await cp(join(project, "portable/ui"), join(staging, "app/ui"), { recursive: true });
    const hashes = {} as Record<Target, string>;
    for (const target of targets) {
      const dir = join(staging, "bin", target); await mkdir(dir, { recursive: true });
      if (inputs.support?.[target]) { await cp(inputs.support[target]!, dir, { recursive: true, dereference: true, errorOnExist: true, force: false }); }
      const binary = join(dir, executableName(target)); const node = join(dir, executableName(target, true));
      await cp(inputs.servers[target], binary); await cp(inputs.nodes[target], node); await chmod(binary, 0o755); await chmod(node, 0o755);
      hashes[target] = (await hashFile(node)).sha256;
      await cp(inputs.nodeLicenses[target], join(staging, "LICENSES", `Node-${target}.txt`));
    }
    if (inputs.desktop) {
      for (const target of targets) {
        const directory = join(staging, "desktop", target); await mkdir(directory, { recursive: true });
        const destination = target.startsWith("macos-") ? "Stick AI.app" : target === "windows-x64" ? "stick-ai.exe" : "stick-ai";
        await cp(inputs.desktop[target], join(directory, destination), { recursive: true, preserveTimestamps: true });
        await chmod(target.startsWith("macos-") ? join(directory, destination, "Contents", "MacOS", "stick-ai") : join(directory, destination), 0o755);
      }
      await cp(inputs.desktopLicenses!, join(staging, "LICENSES", "desktop"), { recursive: true });
    }
    await cp(inputs.lite, join(staging, modelFile("stellan-1-lite"))); await cp(inputs.max, join(staging, modelFile("stellan-1-max")));
    const licences: Record<string, string> = { "MIT.txt": "LICENSE", "Apache-2.0.txt": "licenses/Apache-2.0.txt", "llama.cpp-MIT.txt": "licenses/llama.cpp-MIT.txt", "NOTICE": "NOTICE", "THIRD_PARTY_LICENSES.md": "THIRD_PARTY_LICENSES.md", "MODEL_LICENSE.md": "MODEL_LICENSE.md" };
    for (const [destination, source] of Object.entries(licences)) { await cp(join(project, source), join(staging, "LICENSES", destination)); }
    const appHash = (await hashFile(join(staging, "app/launcher.cjs"))).sha256;
    await writeFile(join(staging, "Start.command"), posixStart(true, hashes, appHash), { mode: 0o755 });
    await writeFile(join(staging, "start.sh"), posixStart(false, hashes, appHash), { mode: 0o755 });
    await writeFile(join(staging, "Start.bat"), windowsStart(hashes["windows-x64"], appHash));
    await chmod(join(staging, "Start.command"), 0o755); await chmod(join(staging, "start.sh"), 0o755);
    await writeFile(join(staging, "README.txt"), userReadme);
    const manifest: Manifest = { format: 1, llamaRelease, nodeRelease, files: [] };
    for (const path of await staticFiles(staging)) {
      const executable = /(?:node|llama-server|stick-ai)(?:\\.exe)?$/.test(path) || ["Start.command", "start.sh"].includes(path);
      manifest.files.push({ path, ...await hashFile(join(staging, path)), executable, ...(path === modelFile("stellan-1-max") ? { optional: true } : {}) });
    }
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await rename(staging, output); return manifest;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
