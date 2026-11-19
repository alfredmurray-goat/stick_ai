import { expect, it } from "vitest";
import { cp, lstat, mkdir, mkdtemp, open, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assets } from "./portable-fixtures.js";
import { buildPlatform } from "../src/portable/package.js";
import { verifyStick } from "../src/portable/integrity.js";

async function stick(root: string): Promise<{ output: string; lite: string }> {
  const fixture = await assets(root);
  // Large enough (over 64 MB) to be remembered between starts.
  const lite = join(root, "big-lite.gguf"); const header = Buffer.alloc(16); header.write("GGUF"); header.writeUInt32LE(3, 4);
  await writeFile(lite, Buffer.concat([header, Buffer.alloc(65 * 1024 ** 2)]));
  const app = join(root, "app"); await cp(fixture.servers["linux-x64"], app);
  const notices = join(root, "notices"); await mkdir(notices); await writeFile(join(notices, "NOTICE.txt"), "Fixture only");
  const output = join(root, "stick");
  await buildPlatform(resolve("."), output, "linux-x64", { app, node: fixture.nodes["linux-x64"], server: fixture.servers["linux-x64"], lite, nodeLicense: fixture.nodeLicenses["linux-x64"], serverLicense: fixture.nodeLicenses["linux-x64"], desktopLicenses: notices, maxRelease: true });
  return { output, lite: join(output, "models/stellan-1-lite-q4_k_m.gguf") };
}

it("remembers checked model files between starts, but notices a model that changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-verify-cache-"));
  try {
    const { output, lite } = await stick(root);
    await verifyStick(output, true);
    await expect(lstat(join(output, "logs/verified-models.json"))).rejects.toThrow();
    const fixed = new Date(1_700_000_000_000); await utimes(lite, fixed, fixed);
    await verifyStick(output, true, undefined, false, true);
    const cache = JSON.parse(await readFile(join(output, "logs/verified-models.json"), "utf8"));
    expect(Object.keys(cache)).toEqual(["models/stellan-1-lite-q4_k_m.gguf"]);
    // Same size and time as the last full check: the model isn't read again (this is the speed-up).
    const file = await open(lite, "r+"); await file.write(Buffer.from("XXXX"), 0, 4, 100); await file.close();
    await utimes(lite, fixed, fixed);
    await verifyStick(output, true, undefined, false, true);
    // A model that was changed and saved normally gets a new time, so it's checked in full and refused.
    await utimes(lite, fixed, new Date(1_700_000_005_000));
    await expect(verifyStick(output, true, undefined, false, true)).rejects.toThrow(/damaged/);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
