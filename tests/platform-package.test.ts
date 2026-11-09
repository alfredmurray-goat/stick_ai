import { expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assets } from "./portable-fixtures.js";
import { buildPlatform } from "../src/portable/package.js";
import { buildUpdateBundle, extractUpdateBundle } from "../src/portable/update-package.js";
import { verifyStick } from "../src/portable/integrity.js";

it.each(["macos-arm64", "windows-x64", "linux-x64"] as const)("packages the updated Lite desktop and target-specific runtime for %s", async (target) => {
  const root = await mkdtemp(join(tmpdir(), "stick-package-"));
  try {
    const fixture = await assets(root);
    const mac = target === "macos-arm64";
    const app = join(root, mac ? "Fixture.app" : "fixture-executable");
    if (mac) { await mkdir(join(app, "Contents/MacOS"), { recursive: true }); }
    await cp(fixture.servers[target], mac ? join(app, "Contents/MacOS/stick-ai") : app);
    const notices = join(root, "notices"); await mkdir(notices); await writeFile(join(notices, "NOTICE.txt"), "Fixture only");
    const inputs = { app, node: fixture.nodes[target], server: fixture.servers[target], lite: fixture.lite, nodeLicense: fixture.nodeLicenses[target], serverLicense: fixture.nodeLicenses[target], desktopLicenses: notices };
    await expect(buildPlatform(resolve("."), join(root, "wrong"), target, { ...inputs, server: fixture.servers["macos-x64"] })).rejects.toThrow("does not match");
    const output = join(root, "release"); const manifest = await buildPlatform(resolve("."), output, target, inputs);
    expect(manifest.targets).toEqual([target]); await verifyStick(output);
    const desktop = mac ? "Stick AI.app/Contents/MacOS/stick-ai" : target === "windows-x64" ? "Stick AI.exe" : "stick-ai";
    expect(manifest.files.some((file) => file.path === desktop)).toBe(true);
    expect(JSON.parse(await readFile(join(output, "app/model-templates.json"), "utf8"))).toEqual({ "stellan-1-lite": "mistral-v1" });
    const launcher = mac ? "Start.command" : target === "windows-x64" ? "Start.bat" : "start.sh";
    expect(await readFile(join(output, launcher), "utf8")).toContain("launcher.cjs");
    expect(manifest.files.some((file) => file.path === "app/stick-update.cjs")).toBe(true);
    const config = JSON.parse(await readFile(join(output, "app/update-config.json"), "utf8"));
    expect(config.target).toBe(target);
    const bundle = join(root, "app-update.gz"); await buildUpdateBundle(output, target, bundle);
    const extracted = join(root, "extracted"); await mkdir(extracted);
    const update = await extractUpdateBundle(bundle, extracted, target, new AbortController().signal);
    expect(update).toEqual(manifest);
    expect(await readFile(join(extracted, desktop))).toEqual(await readFile(join(output, desktop)));
    await expect(readFile(join(extracted, "models/stellan-1-lite-q4_k_m.gguf"))).rejects.toThrow();
    await writeFile(join(output, desktop), "tampered"); await expect(verifyStick(output)).rejects.toThrow("damaged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("packages a supplied Max GGUF without treating model weights as an executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-package-max-"));
  try {
    const fixture = await assets(root); const notices = join(root, "notices"); await mkdir(notices); await writeFile(join(notices, "NOTICE.txt"), "Fixture");
    const target = "linux-x64"; const output = join(root, "release");
    const manifest = await buildPlatform(resolve("."), output, target, { app: fixture.servers[target], node: fixture.nodes[target], server: fixture.servers[target], lite: fixture.lite, max: fixture.max, nodeLicense: fixture.nodeLicenses[target], serverLicense: fixture.nodeLicenses[target], desktopLicenses: notices });
    expect(manifest.files.find((file) => file.path === "models/stellan-1-max-q4_k_m.gguf")?.optional).toBe(true);
    await verifyStick(output);
    const bundle = join(root, "app.gz"); await buildUpdateBundle(output, target, bundle, true);
    const extracted = join(root, "extracted"); await mkdir(extracted);
    const compatible = await extractUpdateBundle(bundle, extracted, target, new AbortController().signal);
    expect(compatible.files.some((file) => file.path === "models/stellan-1-max-q4_k_m.gguf")).toBe(false);
    expect(compatible.files.find((file) => file.path === "models/stellan-1-lite-q4_k_m.gguf")?.sha256).toBe(manifest.files.find((file) => file.path === "models/stellan-1-lite-q4_k_m.gguf")?.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
