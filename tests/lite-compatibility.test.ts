import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelTemplateArgs } from "../src/portable/engine.js";
import { llamaRelease } from "../src/portable/platform.js";
it("uses the Mamba2-capable pinned release and applies the Lite-specific formatter only to Lite", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-lite-template-"));
  try {
    expect(llamaRelease).toBe("v0.9.0");
    expect(await modelTemplateArgs(root, "stellan-1-lite")).toEqual([]);
    await mkdir(join(root, "app")); await writeFile(join(root, "app/model-templates.json"), JSON.stringify({ "stellan-1-lite": "mistral-v1" }));
    expect(await modelTemplateArgs(root, "stellan-1-lite")).toEqual(["--no-jinja", "--skip-chat-parsing", "--chat-template", "mistral-v1"]);
    expect(await modelTemplateArgs(root, "stellan-1-max")).toEqual([]);
    await writeFile(join(root, "app/model-templates.json"), JSON.stringify({ "stellan-1-lite": "../../untrusted" }));
    await expect(modelTemplateArgs(root, "stellan-1-lite")).rejects.toThrow("Unsupported");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects malformed template configuration instead of silently loading a different prompt format", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-lite-bad-template-"));
  try {
    await mkdir(join(root, "app")); await writeFile(join(root, "app/model-templates.json"), "{");
    await expect(modelTemplateArgs(root, "stellan-1-lite")).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("builds a Lite-only Intel package with its own template and complete target-specific integrity checks", async () => {
  const { cp, readFile } = await import("node:fs/promises"); const { resolve } = await import("node:path");
  const { assets } = await import("./portable-fixtures.js"); const { buildIntel } = await import("../src/portable/intel.js");
  const { verifyStick } = await import("../src/portable/integrity.js");
  const root = await mkdtemp(join(tmpdir(), "stick-intel-release-"));
  try {
    const fixture = await assets(root); const app = join(root, "Fixture.app"); await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await cp(fixture.servers["macos-x64"], join(app, "Contents/MacOS/stick-ai"));
    const notices = join(root, "native-notices"); await mkdir(notices); await writeFile(join(notices, "NOTICE.txt"), "Fixture notices");
    const output = join(root, "release");
    const manifest = await buildIntel(resolve("."), output, { app, node: fixture.nodes["macos-x64"], server: fixture.servers["macos-x64"], lite: fixture.lite, nodeLicense: fixture.nodeLicenses["macos-x64"], serverLicense: fixture.nodeLicenses["macos-x64"], desktopLicenses: notices });
    expect(manifest.targets).toEqual(["macos-x64"]); await expect(verifyStick(output)).resolves.toHaveProperty("format", 1);
    expect(JSON.parse(await readFile(join(output, "app/model-templates.json"), "utf8"))).toEqual({ "stellan-1-lite": "mistral-v1" });
    await writeFile(join(output, "app/model-templates.json"), "{}"); await expect(verifyStick(output)).rejects.toThrow("damaged");
    const index = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")); index.targets = ["untrusted-platform"];
    await writeFile(join(output, "manifest.json"), JSON.stringify(index)); await expect(verifyStick(output)).rejects.toThrow("damaged");
  } finally { await rm(root, { recursive: true, force: true }); }
});
