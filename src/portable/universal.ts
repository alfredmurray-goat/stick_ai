import { chmod, cp, link, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { posixStart, windowsStart } from "./build.js";
import { hashFile, staticFiles, verifyStick, type FileRecord, type Manifest } from "./integrity.js";
import { bundledMax } from "./max-release.js";
import { llamaRelease, nodeRelease, targets, type Target } from "./platform.js";

// One stick for every computer: the four verified platform packages share one app folder and one copy
// of each model, and each computer opens its own desktop app (a single universal app on Macs).
export interface UniversalInputs {
  /** Extracted, verified platform packages. Lite is moved out of the Linux one. */
  bases: Record<Target, string>;
  /** "Stick AI.app" holding one executable with both Intel and Apple Silicon code. */
  macApp: string;
  /** Max GGUF to hard-link in. Without it the stick records the pinned Max as optional. */
  max?: string;
}
const lite = "models/stellan-1-lite-q4_k_m.gguf";
const desktops: Record<Target, string> = { "macos-arm64": "Stick AI.app", "macos-x64": "Stick AI.app", "windows-x64": "Stick AI.exe", "linux-x64": "stick-ai" };
const perTargetLicences = ["LICENSES/Node.txt", "LICENSES/llama.cpp.txt"];
const regenerated = new Set(["README.txt", "Start.command", "Start.bat", "start.sh", "app/update-config.json"]);

export const universalReadme = `YOUR PRIVATE ASSISTANT

This stick works on Mac, Windows and Linux. Open the app for your computer:

  Mac      Stick AI (Stick AI.app). The first time, right-click it and choose Open.
  Windows  Stick AI.exe. If Windows warns you, choose More info, then Run anyway.
  Linux    stick-ai

Then click Open workspace. Everything runs on this computer; nothing is sent anywhere.
Lite needs 8 GB of memory. Max needs at least 16 GB and runs best with 24 GB or more.

Keep the stick connected while you work, and close the app before ejecting it.
Start.command, Start.bat and start.sh are fallbacks for technical users.
`;

/** True when the file is a Mach-O universal binary containing both x86_64 and arm64 code. */
export async function universalMachO(path: string): Promise<boolean> {
  const handle = await open(path, "r"); const header = Buffer.alloc(8 + 20 * 8);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (header.readUInt32BE(0) !== 0xcafebabe) { return false; }
  const count = header.readUInt32BE(4); if (count < 2 || count > 8) { return false; }
  const cpus = new Set(Array.from({ length: count }, (_, index) => header.readUInt32BE(8 + index * 20)));
  return cpus.has(0x01000007) && cpus.has(0x0100000c);
}
async function placeFile(from: string, to: string, move: boolean): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  if (move) { try { await rename(from, to); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") { throw error; } } }
  await cp(from, to);
}
export async function assembleUniversalStick(output: string, inputs: UniversalInputs, log: (message: string) => void = () => {}): Promise<Manifest> {
  if (!await universalMachO(join(inputs.macApp, "Contents/MacOS/stick-ai"))) { throw new Error("The Mac app must be a universal binary with Intel and Apple Silicon code"); }
  try { await lstat(output); throw new Error(`Output already exists: ${output}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
  const manifests = {} as Record<Target, Manifest>;
  for (const target of targets) {
    const manifest = await verifyStick(inputs.bases[target], true);
    if (manifest.targets?.length !== 1 || manifest.targets[0] !== target) { throw new Error(`The ${target} package is for a different computer`); }
    manifests[target] = manifest;
  }
  const staging = `${output}.building-${randomUUID()}`;
  const executable = new Map<string, boolean>(); const sharedFrom = new Map<string, FileRecord>();
  try {
    for (const path of ["app/project", "logs", "models"]) { await mkdir(join(staging, path), { recursive: true }); }
    for (const target of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"] as Target[]) {
      const base = inputs.bases[target];
      for (const record of manifests[target].files) {
        const { path } = record;
        if (path.startsWith("models/") || regenerated.has(path) || path.startsWith("Stick AI.app/")) { continue; }
        let destination: string | undefined;
        if (path.startsWith(`bin/${target}/`) || path === desktops[target]) { destination = path; }
        else if (perTargetLicences.includes(path) || path.startsWith("LICENSES/desktop/")) { destination = `LICENSES/${target}/${path.slice("LICENSES/".length)}`; }
        else {
          // Shared files (the app, UI and common licences) are built from the same commit on every runner.
          const first = sharedFrom.get(path);
          if (first) { if (first.sha256 !== record.sha256) { log(`Note: ${path} differs on ${target}; keeping the Linux build`); } continue; }
          sharedFrom.set(path, record); destination = path;
        }
        await placeFile(join(base, path), join(staging, destination), false);
        executable.set(destination, record.executable);
      }
    }
    await cp(inputs.macApp, join(staging, "Stick AI.app"), { recursive: true, preserveTimestamps: true });
    await chmod(join(staging, "Stick AI.app/Contents/MacOS/stick-ai"), 0o755); executable.set("Stick AI.app/Contents/MacOS/stick-ai", true);
    await placeFile(join(inputs.bases["linux-x64"], lite), join(staging, lite), true);
    if (inputs.max) { await link(inputs.max, join(staging, bundledMax.path)); }
    const linuxConfig = JSON.parse(await readFile(join(inputs.bases["linux-x64"], "app/update-config.json"), "utf8"));
    await writeFile(join(staging, "app/update-config.json"), JSON.stringify({ ...linuxConfig, target: "universal" }) + "\n");
    const hashes = {} as Record<Target, string>;
    for (const target of targets) { hashes[target] = (await hashFile(join(staging, `bin/${target}/node${target === "windows-x64" ? ".exe" : ""}`))).sha256; }
    const appHash = (await hashFile(join(staging, "app/launcher.cjs"))).sha256;
    await writeFile(join(staging, "Start.command"), posixStart(true, hashes, appHash), { mode: 0o755 });
    await writeFile(join(staging, "start.sh"), posixStart(false, hashes, appHash), { mode: 0o755 });
    await writeFile(join(staging, "Start.bat"), windowsStart(hashes["windows-x64"], appHash));
    await writeFile(join(staging, "README.txt"), universalReadme);
    for (const path of ["Start.command", "start.sh"]) { await chmod(join(staging, path), 0o755); executable.set(path, true); }
    const manifest: Manifest = { format: 1, llamaRelease, nodeRelease, targets: [...targets], files: [] };
    for (const path of await staticFiles(staging)) {
      const models = path === lite || path === bundledMax.path;
      manifest.files.push({ path, ...await hashFile(join(staging, path)), executable: executable.get(path) ?? false, ...(models ? { optional: true } : {}) });
    }
    if (!inputs.max) { manifest.files.push({ ...bundledMax, executable: false, optional: true }); }
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await verifyStick(staging, !inputs.max, undefined, true);
    await rename(staging, output); return manifest;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
