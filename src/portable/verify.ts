#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { Sandbox } from "../sandbox/paths.js";
import { resolve } from "node:path";
import { verifyStick } from "./integrity.js";

export async function verifyMain(root: string): Promise<void> {
  await verifyStick(resolve(root));
  console.log("All files match the recorded checksums.");
}
if (process.argv[1] && /verify\.(?:js|cjs)$/.test(process.argv[1])) {
  verifyMain(process.argv[2] ?? ".").catch(async (error) => {
    try { const box = await Sandbox.create(resolve(process.argv[2] ?? ".")); await mkdir(await box.path("logs", true), { recursive: true }); await appendFile(await box.path("logs/launcher.log", true), `${String(error)}\n`); } catch {}
    console.error("A file is missing or changed; ask for a fresh copy of the stick."); process.exitCode = 1; });
}
