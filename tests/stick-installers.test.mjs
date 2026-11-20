import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { macInstaller, writeInstallers } from "../scripts/stick-installers.mjs";
const run = promisify(execFile);

it.skipIf(process.platform === "win32")("copies the apps onto a stick without touching the models already there", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-installer-"));
  try {
    const download = join(root, "download"), stick = join(root, "STICK AI");
    await mkdir(join(download, "stick_ai/stellan/app"), { recursive: true }); await mkdir(join(download, "stick_ai/stellan/models"));
    await writeFile(join(download, "stick_ai/stellan/app/launcher.cjs"), "new app"); await writeFile(join(download, "stick_ai/Stick AI.exe"), "exe");
    await writeInstallers(download);
    await mkdir(join(stick, "stellan/models"), { recursive: true }); await mkdir(join(stick, "stellan/app"), { recursive: true });
    await writeFile(join(stick, "stellan/models/stellan-1-lite-q4_k_m.gguf"), "my lite");
    await writeFile(join(stick, "stellan/app/launcher.cjs"), "old app"); await writeFile(join(stick, "notes.txt"), "mine");
    const { stdout } = await run("sh", [join(download, "install-on-stick.sh"), stick]);
    expect(await readFile(join(stick, "stellan/app/launcher.cjs"), "utf8")).toBe("new app");
    expect(await readFile(join(stick, "Stick AI.exe"), "utf8")).toBe("exe");
    expect(await readFile(join(stick, "stellan/models/stellan-1-lite-q4_k_m.gguf"), "utf8")).toBe("my lite");
    expect(await readFile(join(stick, "notes.txt"), "utf8")).toBe("mine");
    expect(stdout).toContain("stellan-1.0-q4_k_m.gguf");
    expect((await readdir(download)).sort()).toEqual(["How to install.txt", "Install on stick (Mac).command", "Install on stick (Windows).bat", "install-on-stick.sh", "stick_ai"]);
    await run("sh", ["-n", join(download, "Install on stick (Mac).command")]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("reads a stick path dragged into Terminal, with escaped spaces or quotes", async () => {
  const clean = macInstaller.split("\n").map((line) => line.trim()).find((line) => line.startsWith("DEST=$(printf"));
  for (const dragged of ["/Volumes/STICK\\ AI ", "'/Volumes/STICK AI'", "/Volumes/STICK AI"]) {
    const { stdout } = await run("sh", ["-c", `DEST="$1"; ${clean}; printf '%s' "$DEST"`, "sh", dragged]);
    expect(stdout).toBe("/Volumes/STICK AI");
  }
});

it.skipIf(process.platform === "win32")("installs on the stick it was unzipped onto when you just press Return", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-installer-volume-"));
  try {
    const volumes = join(root, "Volumes"), stick = join(volumes, "STICK_AI"), download = join(stick, "stick_ai-all-devices"), bin = join(root, "bin");
    await mkdir(join(download, "stick_ai/stellan/app"), { recursive: true }); await writeFile(join(download, "stick_ai/stellan/app/launcher.cjs"), "new app");
    await mkdir(join(stick, "stellan/models"), { recursive: true }); await writeFile(join(stick, "stellan/models/stellan-1-lite-q4_k_m.gguf"), "my lite");
    await writeInstallers(download);
    // ditto exists only on macOS; this stand-in merges the same way for the test.
    await mkdir(bin); await writeFile(join(bin, "ditto"), '#!/bin/sh\nshift; shift; cp -R "$1"/. "$2"/\n', { mode: 0o755 });
    const helper = join(download, "Install on stick (Mac).command");
    const child = execFile("sh", [helper], { env: { ...process.env, STICK_VOLUMES: volumes, PATH: `${bin}:${process.env.PATH}` } });
    let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stdin.end("\n");
    await new Promise((resolve, reject) => child.on("exit", (code) => code === 0 ? resolve(code) : reject(new Error(stdout))));
    expect(stdout).toContain("Press Return to install on STICK_AI");
    expect(await readFile(join(stick, "stellan/app/launcher.cjs"), "utf8")).toBe("new app");
    expect(await readFile(join(stick, "stellan/models/stellan-1-lite-q4_k_m.gguf"), "utf8")).toBe("my lite");
    expect(stdout).toContain("You can now delete the download folder on the stick (stick_ai-all-devices)");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("asks again instead of quitting when nothing usable is entered", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-installer-retry-"));
  try {
    const download = join(root, "download"); await mkdir(join(download, "stick_ai"), { recursive: true }); await writeInstallers(download);
    const child = execFile("sh", [join(download, "Install on stick (Mac).command")], { env: { ...process.env, STICK_VOLUMES: join(root, "none") } });
    let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stdin.end("\n/not/here\n\n");
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(1); expect(stdout.match(/Try again/g)).toHaveLength(3); expect(stdout).toContain("No stick chosen");
  } finally { await rm(root, { recursive: true, force: true }); }
});
