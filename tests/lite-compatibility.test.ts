import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelTemplateArgs, modelRuntimeArgs, gpuLayerArgs, ManagedEngine } from "../src/portable/engine.js";
import { llamaRelease, UserError } from "../src/portable/platform.js";
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
    expect(manifest.runtime).toBe("stellan-run");
    expect(manifest.files.find(file => file.path === "bin/macos-x64/stellan-run")?.sha256).toBe(manifest.files.find(file => file.path === "bin/macos-x64/llama-server")?.sha256);
    expect(manifest.files.some(file => file.path === "app/stick-engine.cjs")).toBe(true);
    expect(manifest.targets).toEqual(["macos-x64"]); await expect(verifyStick(output)).resolves.toHaveProperty("format", 1);
    expect(JSON.parse(await readFile(join(output, "app/model-templates.json"), "utf8"))).toEqual({ "stellan-1-lite": "mistral-v1" });
    await writeFile(join(output, "app/model-templates.json"), "{}"); await expect(verifyStick(output)).rejects.toThrow("damaged");
    const index = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")); index.targets = ["untrusted-platform"];
    await writeFile(join(output, "manifest.json"), JSON.stringify(index)); await expect(verifyStick(output)).rejects.toThrow("damaged");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

it("bounds Lite recurrent-state memory without reducing its configured context window", () => {
  const args = modelRuntimeArgs("stellan-1-lite");
  expect(args).toEqual(["--parallel", "1", "--no-repack", "--batch-size", "512", "--ubatch-size", "256", "--cache-ram", "0", "--ctx-checkpoints", "1"]);
  expect(args).not.toContain("--ctx-size"); expect(modelRuntimeArgs("stellan-1-max", true)).toEqual(["--parallel", "1", "--no-repack", "--batch-size", "128", "--ubatch-size", "64", "--cache-ram", "0"]);
  // Max normally adds the 8-bit cache (which needs flash attention) and n-gram speculative decoding.
  expect(modelRuntimeArgs("stellan-1-max")).toEqual(["--parallel", "1", "--no-repack", "--batch-size", "128", "--ubatch-size", "64", "--cache-ram", "0", "--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--spec-type", "ngram-simple"]);
});

it("offloads to the Apple Silicon GPU only where it fits, and stays CPU-only elsewhere", () => {
  const GiB = 1024 ** 3;
  expect(gpuLayerArgs("macos-arm64", "stellan-1-lite", 8 * GiB, {})).toEqual(["--gpu-layers", "999"]);
  expect(gpuLayerArgs("macos-arm64", "stellan-1-max", 16 * GiB, {})).toEqual(["--gpu-layers", "0"]);
  expect(gpuLayerArgs("macos-arm64", "stellan-1-max", 24 * GiB, {})).toEqual(["--gpu-layers", "999"]);
  expect(gpuLayerArgs("macos-arm64", "stellan-1-lite", 32 * GiB, { STICK_GPU: "0" })).toEqual(["--gpu-layers", "0"]);
  for (const target of ["macos-x64", "windows-x64", "linux-x64"] as const) expect(gpuLayerArgs(target, "stellan-1-lite", 64 * GiB, {})).toEqual(["--gpu-layers", "0"]);
  expect(gpuLayerArgs("macos-arm64", "stellan-1-lite", 32 * GiB, {}, true)).toEqual(["--gpu-layers", "0"]);
});
it("falls back to the CPU for the rest of the session when a GPU start fails", async () => {
  const engine = new ManagedEngine("/nonexistent", "macos-arm64", 1, "/tmp", 0, () => {});
  engine.detectVirtualMachine = () => false; // CI macOS runners are virtual Macs
  const launch = vi.spyOn(engine as unknown as { launch: (...args: unknown[]) => Promise<void> }, "launch")
    .mockRejectedValueOnce(new UserError("loading")).mockResolvedValue(undefined);
  const signal = new AbortController().signal;
  await engine.start("stellan-1-lite", signal);
  expect(launch.mock.calls.map((call) => call[2])).toEqual([["--gpu-layers", "999"], ["--gpu-layers", "0"]]);
  expect(engine.gpuFailed).toBe(true);
  await engine.start("stellan-1-lite", signal);
  expect(launch.mock.calls.at(-1)![2]).toEqual(["--gpu-layers", "0"]);
  launch.mockRejectedValueOnce(new UserError("loading"));
  await expect(engine.start("stellan-1-lite", signal)).rejects.toThrow("loading");
});
