import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, totalmem } from "node:os";
import { buildStick } from "../src/portable/build.js";
import { GiB } from "../src/config/models.js";
import { assets } from "./portable-fixtures.js";

it.skipIf(process.platform !== "linux" || totalmem() < 8 * GiB)("Linux with 8GB: loss of the real status process stops its detached UI and deletes its temp folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-supervisor-"));
  const temp = join(root, "private-temp"); const commands = join(root, "commands");
  await mkdir(temp); await mkdir(commands);
  const inputs = await assets(root); inputs.nodes["linux-x64"] = process.execPath;
  const stick = join(root, "stick"); await buildStick(resolve("."), stick, inputs);
  const urlFile = join(stick, "logs", "test-url");
  await writeFile(join(commands, "xdg-open"), `#!/bin/sh\nprintf '%s' "$1" > '${urlFile}'\n`, { mode: 0o755 });
  const status = spawn(join(stick, "bin/linux-x64/node"), [join(stick, "app/launcher.cjs"), "--root", stick], { env: { ...process.env, TMPDIR: temp, PATH: commands + ":" + process.env.PATH }, stdio: "ignore" });
  let url = "";
  try {
    for (let i = 0; i < 250; i++) {
      try { url = await readFile(urlFile, "utf8"); if (url) { break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#/);
    expect((await readdir(temp)).filter((name) => name.startsWith("stick-ai-"))).toHaveLength(1);
    const address = new URL(url);
    expect((await fetch(address.origin)).status).toBe(200);
    status.kill("SIGKILL");
    let contents: string[] = [];
    for (let i = 0; i < 150; i++) { contents = await readdir(temp); if (!contents.length) { break; } await new Promise((resolve) => setTimeout(resolve, 30)); }
    expect(contents).toEqual([]);
    await expect(fetch(address.origin)).rejects.toThrow();
  } finally {
    if (status.exitCode === null && status.signalCode === null) { status.kill("SIGTERM"); }
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
