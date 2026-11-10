import { expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assets } from "./portable-fixtures.js";
import { buildPlatform } from "../src/portable/package.js";
import { hashFile, verifyStick } from "../src/portable/integrity.js";
import { bundledMax } from "../src/portable/max-release.js";
import { prepareDmgModels } from "../scripts/macos-dmg.mjs";
it.each(["full", "lite-picker"])("prepares %s with the real file-picker helper and exactly the intended model set", async (variant) => {
  const temporary = await mkdtemp(join(tmpdir(), "stick-dmg-variant-"));
  try {
    const fixture = await assets(temporary), app = join(temporary, "Test.app");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true }); await cp(fixture.servers["macos-x64"], join(app, "Contents/MacOS/stick-ai"));
    const notices = join(temporary, "notices"); await mkdir(notices); await writeFile(join(notices, "NOTICE.txt"), "Fixture");
    const root = join(temporary, "Stick AI");
    const manifest = await buildPlatform(resolve("."), root, "macos-x64", { app, lite: fixture.lite, node: fixture.nodes["macos-x64"], server: fixture.servers["macos-x64"], nodeLicense: fixture.nodeLicenses["macos-x64"], serverLicense: fixture.nodeLicenses["macos-x64"], desktopLicenses: notices, maxRelease: true });
    const expectedMax = { ...bundledMax, ...await hashFile(fixture.max) }, maxBytes = await readFile(fixture.max);
    manifest.files = manifest.files.map((record) => record.path === bundledMax.path ? expectedMax : record);
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    if (variant === "lite-picker") { await cp(fixture.max, join(root, bundledMax.path)); }
    await prepareDmgModels(root, variant, variant === "full" ? fixture.max : undefined, expectedMax);
    const prepared = await verifyStick(root);
    expect(prepared.files.some((record) => record.path === "app/stick-models.cjs")).toBe(true);
    expect(prepared.files.filter((record) => record.path.startsWith("models/"))).toHaveLength(variant === "full" ? 2 : 1);
    expect(await readFile(join(root, "models/stellan-1-lite-q4_k_m.gguf"))).toEqual(await readFile(fixture.lite));
    if (variant === "full") { expect(await readFile(join(root, bundledMax.path))).toEqual(maxBytes); }
    else { await expect(readFile(join(root, bundledMax.path))).rejects.toThrow(); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
