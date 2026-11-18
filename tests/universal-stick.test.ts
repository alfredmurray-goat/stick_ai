import { expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assets } from "./portable-fixtures.js";
import { buildPlatform } from "../src/portable/package.js";
import { assembleUniversalStick, universalMachO, universalUpdateSource } from "../src/portable/universal.js";
import { hashFile, verifyStick } from "../src/portable/integrity.js";
import { buildUpdateBundle, extractUpdateBundle } from "../src/portable/update-package.js";
import { applyPreparedUpdate, prepareUpdate, readUpdateConfig } from "../src/portable/update.js";
import type { UpdateFeed } from "../src/portable/update-format.js";
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
    expect(manifest.targets).toEqual([...targets]);
    const shared = join(output, "Stellan"); const sharedManifest = await verifyStick(shared, true);
    for (const app of ["Stick AI.app/Contents/MacOS/stick-ai", "Stick AI.exe", "stick-ai", "Read me.txt"]) { expect((await lstat(join(output, app))).isFile()).toBe(true); }
    expect(sharedManifest.files.some((file) => file.path.startsWith("Stick AI"))).toBe(false);
    const paths = manifest.files.map((file) => file.path);
    for (const path of ["Stick AI.app/Contents/MacOS/stick-ai", "Stick AI.exe", "stick-ai", "Start.command", "Start.bat", "start.sh", "models/stellan-1-lite-q4_k_m.gguf", ...targets.map((target) => `LICENSES/${target}/Node.txt`)]) { expect(paths).toContain(path); }
    for (const target of targets) { expect(paths).toContain(`bin/${target}/node${target === "windows-x64" ? ".exe" : ""}`); }
    expect(paths.filter((path) => path.startsWith("models/"))).toHaveLength(2);
    expect(manifest.files.find((file) => file.path === "Stick AI.app/Contents/MacOS/stick-ai")?.executable).toBe(true);
    const mac = await readFile(join(shared, "Start.command"), "utf8");
    expect(mac).toContain("macos-arm64"); expect(mac).toContain("macos-x64");
    expect((await readUpdateConfig(shared)).target).toBe("universal");
    expect(await readFile(join(shared, "README.txt"), "utf8")).toContain("Mac, Windows and Linux");
    const bundle = join(root, "universal.gz"); await buildUpdateBundle(shared, "universal", bundle, true, await universalUpdateSource(output));
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
it("updates a Stellan-layout stick, replacing the apps beside the shared folder and keeping the models", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-universal-update-"));
  const env = { id: process.env.GITHUB_RUN_ID, sha: process.env.GITHUB_SHA };
  const key = generateKeyPairSync("ed25519"); const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  async function stick(name: string, sequence: number, appBytes?: string) {
    process.env.GITHUB_RUN_ID = String(sequence); process.env.GITHUB_SHA = sequence.toString(16).padStart(40, "0");
    const folder = join(root, name); await mkdir(folder); const bases = await platforms(folder);
    if (appBytes) { await writeFile(join(bases["windows-x64"], "Stick AI.exe"), Buffer.concat([await readFile(join(bases["windows-x64"], "Stick AI.exe")), Buffer.from(appBytes)])); }
    // Re-record the edited Windows app so its package still verifies.
    const manifestPath = join(bases["windows-x64"], "manifest.json"); const m = JSON.parse(await readFile(manifestPath, "utf8"));
    const record = m.files.find((file: { path: string }) => file.path === "Stick AI.exe"); Object.assign(record, await hashFile(join(bases["windows-x64"], "Stick AI.exe")));
    await writeFile(manifestPath, JSON.stringify(m, null, 2) + "\n");
    const macApp = join(folder, "Universal.app"); await mkdir(join(macApp, "Contents/MacOS"), { recursive: true }); await writeFile(join(macApp, "Contents/MacOS/stick-ai"), fatMachO());
    const output = join(folder, "STICK"); await assembleUniversalStick(output, { bases, macApp }); return output;
  }
  try {
    const current = await stick("v1", 1); const next = await stick("v2", 2, "new Windows app");
    await writeFile(join(current, "Stellan/app/project/keep.txt"), "my project");
    const bundle = join(root, "stick_ai-update-universal.gz"); await buildUpdateBundle(join(next, "Stellan"), "universal", bundle, true, await universalUpdateSource(next));
    const hash = await hashFile(bundle); const bytes = await readFile(bundle);
    const feed: UpdateFeed = { format: 1, repository: "alfredmurray-goat/stick_ai", sequence: 2, source: (2).toString(16).padStart(40, "0"),
      assets: [...targets.map((target) => ({ target, name: `stick_ai-update-${target}.gz`, sha256: "a".repeat(64), size: 1 })), { target: "universal", name: "stick_ai-update-universal.gz", ...hash }] };
    const payload = Buffer.from(JSON.stringify(feed)); const envelope = { payload: payload.toString("base64"), signature: sign(null, payload, key.privateKey).toString("base64") };
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => url.toString().endsWith("/stick_ai-updates.json") ? Response.json(envelope) : url.toString().endsWith("/2/stick_ai-update-universal.gz") ? new Response(bytes) : new Response("missing", { status: 404 })));
    const shared = join(current, "Stellan"); const lite = (await lstat(join(shared, "models/stellan-1-lite-q4_k_m.gguf"))).ino;
    const work = await prepareUpdate(shared, "", new AbortController().signal, publicKey);
    await applyPreparedUpdate(shared, work, publicKey);
    expect(await readFile(join(current, "Stick AI.exe"), "utf8")).toContain("new Windows app");
    expect((await readUpdateConfig(shared)).sequence).toBe(2);
    expect((await lstat(join(shared, "models/stellan-1-lite-q4_k_m.gguf"))).ino).toBe(lite);
    expect(await readFile(join(shared, "app/project/keep.txt"), "utf8")).toBe("my project");
    await expect(lstat(join(shared, "Stick AI.exe"))).rejects.toThrow();
    await verifyStick(shared, true);
  } finally {
    vi.unstubAllGlobals();
    if (env.id === undefined) { delete process.env.GITHUB_RUN_ID; } else { process.env.GITHUB_RUN_ID = env.id; }
    if (env.sha === undefined) { delete process.env.GITHUB_SHA; } else { process.env.GITHUB_SHA = env.sha; }
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
