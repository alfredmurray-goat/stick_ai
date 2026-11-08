import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertModelAllowed, GiB, modelChoices, pickModel, ramStatus, renderModelPicker } from "../src/config/models.js";
import { loadConfig } from "../src/config/index.js";
import { Sandbox } from "../src/sandbox/paths.js";
import { Ollama } from "../src/model/ollama.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe("RAM lock", () => {
  it.each([[8, true], [15.9, true], [16, false]] as const)("checks %s GiB", (amount, locked) => {
    const ram = ramStatus(amount * GiB);
    expect(ram.maxLocked).toBe(locked);
    expect(modelChoices(ram)[1]?.disabled).toBe(locked);
    expect(modelChoices(ram)[0]?.disabled).toBe(false);
    expect(assertModelAllowed("stellan-1-lite", ram)).toBe("stellan-1-lite");
    if (locked) {
      expect(() => assertModelAllowed("stellan-1-max", ram)).toThrow("needs 16GB RAM or more");
      expect(() => pickModel("2", "stellan-1-lite", ram)).toThrow("Your Mac has");
    } else { expect(pickModel("2", "stellan-1-lite", ram)).toBe("stellan-1-max"); }
  });
  it("uses the exact byte threshold rather than a rounded display", () => {
    expect(ramStatus(16 * GiB - 1).maxLocked).toBe(true);
    expect(ramStatus(16 * GiB).maxLocked).toBe(false);
  });
  it("force-max unlocks Max with a warning", () => {
    const ram = ramStatus(8 * GiB, true);
    expect(assertModelAllowed("stellan-1-max", ram)).toBe("stellan-1-max");
    expect(ram.warning).toContain("very slow or crash");
  });
  it("shows a grey disabled Max entry with the required message", () => {
    const text = renderModelPicker(ramStatus(8 * GiB), true);
    expect(text).toContain("\x1b[90m2. Stellan-1 Max");
    expect(text).toContain("Stellan-1 Max needs 16GB RAM or more. Your Mac has 8 GB.");
    expect(renderModelPicker(ramStatus(8 * GiB), false)).not.toContain("\x1b[");
  });
  it("refuses a locked direct client before making a model request", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => new Ollama("stellan-1-max", "http://localhost:11434", false, ramStatus(8 * GiB))).toThrow("needs 16GB");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not silently downgrade a locked STICK_MODEL override", async () => {
    const root = await mkdtemp(join(tmpdir(), "stick-models-")); roots.push(root);
    vi.stubEnv("STICK_MODEL", "stellan-1-max");
    const config = await loadConfig(await Sandbox.create(root), false);
    expect(config.model).toBe("stellan-1-max");
    expect(() => assertModelAllowed(config.model, ramStatus(8 * GiB))).toThrow("needs 16GB");
  });
  it("defaults to Lite and migrates the old stored model name", async () => {
    const root = await mkdtemp(join(tmpdir(), "stick-models-")); roots.push(root);
    const box = await Sandbox.create(root);
    expect((await loadConfig(box, false)).model).toBe("stellan-1-lite");
    await mkdir(join(root, ".stick"));
    await writeFile(join(root, ".stick/config.json"), JSON.stringify({ model: "stellan-1.0" }));
    expect((await loadConfig(box, false)).model).toBe("stellan-1-lite");
  });
});
