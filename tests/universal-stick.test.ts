import { expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assets } from "./portable-fixtures.js";
import { buildPlatform } from "../src/portable/package.js";
import { assembleUniversalStick, universalMachO } from "../src/portable/universal.js";
import { verifyStick } from "../src/portable/integrity.js";
import { buildUpdateBundle, extractUpdateBundle } from "../src/portable/update-package.js";
import { readUpdateConfig } from "../src/portable/update.js";
import { targets, type Target } from "../src/portable/platform.js";

function fatMachO(): Buffer {
  const data = Buffer.alloc(4096); data.writeUInt32BE(0xcafebabe, 0); data.writeUInt32BE(2, 4);
  data.writeUInt32BE(0x01000007, 8); data.writeUInt32BE(0x0100000c, 28); return data;
}
async function platforms(root: string): Promise<Record<Target, string>> {
  const fixture = await assets(root); const notices = join(root, "notices"); await mkdir(notices); await writeFile(join(notices, "NOTICE.txt"), "Fixture only");
  const bases = {} as Record<Target, string>;
  for (const target of targets) {
    const mac = target.startsWith("macos-"); const app = join(root, `${target}-app${mac ? ".app" : ""}`);
    if (mac) { await mkdir(join(app, "Contents/MacOS"), { recursive: true }); }
    await cp(fixture.servers[target], mac ? join(app, "Contents/MacOS/stick-ai") : app);
    bases[target] = join(root, `base-${target}`);
    await buildPlatform(resolve("."), bases[target], target, { app, node: fixture.nodes[target], server: fixture.servers[target], lite: fixture.lite, nodeLicense: fixture.nodeLicenses[target], serverLicense: fixture.nodeLicenses[target], desktopLicenses: notices, maxRelease: true });
  }
  return bases;
}
it("merges the four platform packages into one verified stick with one copy of each model", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-universal-"));
  try {
    const bases = await platforms(root);
    const macApp = join(root, "Universal.app"); await mkdir(join(macApp, "Contents/MacOS"), { recursive: true });
    await writeFile(join(macApp, "Contents/MacOS/stick-ai"), fatMachO()); await writeFile(join(macApp, "Contents/Info.plist"), "<plist/>");
    expect(await universalMachO(join(macApp, "Contents/MacOS/stick-ai"))).toBe(true);
    const output = join(root, "Stick AI");
    const manifest = await assembleUniversalStick(output, { bases, macApp });
    expect(manifest.targets).toEqual([...targets]); await verifyStick(output, true);
    const paths = manifest.files.map((file) => file.path);
    for (const path of ["Stick AI.app/Contents/MacOS/stick-ai", "Stick AI.exe", "stick-ai", "Start.command", "Start.bat", "start.sh", "models/stellan-1-lite-q4_k_m.gguf", ...targets.map((target) => `LICENSES/${target}/Node.txt`)]) { expect(paths).toContain(path); }
    for (const target of targets) { expect(paths).toContain(`bin/${target}/node${target === "windows-x64" ? ".exe" : ""}`); }
    expect(paths.filter((path) => path.startsWith("models/"))).toHaveLength(2);
    expect(manifest.files.find((file) => file.path === "Stick AI.app/Contents/MacOS/stick-ai")?.executable).toBe(true);
    const mac = await readFile(join(output, "Start.command"), "utf8");
    expect(mac).toContain("macos-arm64"); expect(mac).toContain("macos-x64");
    expect((await readUpdateConfig(output)).target).toBe("universal");
    expect(await readFile(join(output, "README.txt"), "utf8")).toContain("Mac, Windows and Linux");
    const bundle = join(root, "universal.gz"); await buildUpdateBundle(output, "universal", bundle);
    const unpacked = join(root, "unpacked"); await mkdir(unpacked);
    const extracted = await extractUpdateBundle(bundle, unpacked, "universal", new AbortController().signal);
    expect(extracted.files.some((file) => file.path === "Stick AI.exe")).toBe(true);
    await expect(lstat(join(unpacked, "models"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
it("refuses a Mac app that only runs on one kind of Mac", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-universal-thin-"));
  try {
    const bases = await platforms(root);
    const macApp = join(root, "Thin.app"); await mkdir(join(macApp, "Contents/MacOS"), { recursive: true });
    await cp(join(bases["macos-arm64"], "Stick AI.app/Contents/MacOS/stick-ai"), join(macApp, "Contents/MacOS/stick-ai"));
    await expect(assembleUniversalStick(join(root, "out"), { bases, macApp })).rejects.toThrow("universal binary");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
