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
  const clean = macInstaller.split("\n").find((line) => line.startsWith("DEST=$(printf"));
  for (const dragged of ["/Volumes/STICK\\ AI ", "'/Volumes/STICK AI'", "/Volumes/STICK AI"]) {
    const { stdout } = await run("sh", ["-c", `DEST="$1"; ${clean}; printf '%s' "$DEST"`, "sh", dragged]);
    expect(stdout).toBe("/Volumes/STICK AI");
  }
});
