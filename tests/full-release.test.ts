import { expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assets } from "./portable-fixtures.js";
import { buildPlatform } from "../src/portable/package.js";
import { hashFile, verifyStick } from "../src/portable/integrity.js";
import { bundledMax } from "../src/portable/max-release.js";
const exec = promisify(execFile);
it.skipIf(process.platform === "win32")("assembles all four complete release formats with both supplied GGUF fixtures and verifies the extracted packages", async () => {
  const { assembleFullRelease } = await import("../scripts/assemble-full-release.mjs");
  const temporary = await mkdtemp(join(tmpdir(), "stick-full-release-"));
  try {
    const fixture = await assets(temporary);
    const expected = { ...bundledMax, ...await hashFile(fixture.max) };
    for (const target of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"] as const) {
      const folder = join(temporary, target); await mkdir(folder);
      const input = join(folder, "input"); await mkdir(input); const base = join(input, "Stick AI");
      const app = target.startsWith("macos-") ? join(folder, "Test.app") : fixture.servers[target];
      if (target.startsWith("macos-")) { await mkdir(join(app, "Contents/MacOS"), { recursive: true }); await cp(fixture.servers[target], join(app, "Contents/MacOS/stick-ai")); }
      const notices = join(folder, "notices"); await mkdir(notices); await writeFile(join(notices, "NOTICE.txt"), "Fixture");
      const manifest = await buildPlatform(resolve("."), base, target, { app, lite: fixture.lite, node: fixture.nodes[target], server: fixture.servers[target], nodeLicense: fixture.nodeLicenses[target], serverLicense: fixture.nodeLicenses[target], desktopLicenses: notices, maxRelease: true });
      expect(manifest.files.find((file) => file.path === bundledMax.path)?.sha256).toBe(bundledMax.sha256);
      await expect(readFile(join(base, bundledMax.path))).rejects.toThrow();
      manifest.files = manifest.files.map((file) => file.path === bundledMax.path ? expected : file);
      await writeFile(join(base, "manifest.json"), JSON.stringify(manifest));
      const archive = join(folder, target === "linux-x64" ? "base.tar.gz" : "base.zip");
      if (target === "linux-x64") { await exec("tar", ["-czf", archive, "-C", input, "Stick AI"]); }
      else { await exec("zip", ["-q", "-r", archive, "Stick AI"], { cwd: input }); }
      const output = await assembleFullRelease(archive, folder, target, fixture.max, expected, verifyStick);
      const unpacked = join(folder, "verify"); await mkdir(unpacked);
      if (target === "linux-x64") { await exec("tar", ["-xzf", output, "-C", unpacked]); }
      else { await exec("unzip", ["-q", output, "-d", unpacked]); }
      await verifyStick(join(unpacked, "Stick AI"));
      expect(await readFile(join(unpacked, "Stick AI", bundledMax.path))).toEqual(await readFile(fixture.max));
      expect(await readFile(join(unpacked, "Stick AI/models/stellan-1-lite-q4_k_m.gguf"))).toEqual(await readFile(fixture.lite));
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 30000);
