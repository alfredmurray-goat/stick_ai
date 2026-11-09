import { expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishAppUpdate } from "../scripts/publish-app-update.mjs";
import { verifyFeed } from "../src/portable/update-format.ts";
const platforms = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"];
const pair = generateKeyPairSync("ed25519");
const signingKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
it("publishes the picker update only after all platform payloads and the valid signed feed have uploaded", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "stick-publish-update-")); const calls = []; let envelope;
  try {
    const gh = async (...args) => {
      calls.push(args);
      if (args[0] === "release" && args[1] === "view") { throw Object.assign(new Error("not found"), { stderr: "release not found" }); }
      if (args[0] === "run" && args[1] === "download") {
        const folder = args[args.indexOf("--dir") + 1]; const name = args[args.indexOf("--name") + 1].replace("stick_ai-update-", "");
        await mkdir(folder); await writeFile(join(folder, `stick_ai-update-${name}.gz`), `payload for ${name}`);
      }
      if (args[1] === "upload" && args[3].endsWith("stick_ai-updates.json")) { envelope = JSON.parse(await readFile(args[3], "utf8")); }
      return "";
    };
    const tag = await publishAppUpdate({ repo: "alfredmurray-goat/stick_ai", runId: "123", source: "a".repeat(40), artifacts: platforms.map((platform) => ({ name: `stick_ai-update-${platform}` })), platforms, temporary, signingKey, publicKey, gh });
    expect(tag).toBe("app-123");
    const feed = verifyFeed(envelope, publicKey, "alfredmurray-goat/stick_ai"); expect(feed.assets).toHaveLength(4);
    expect(calls.filter((args) => args[1] === "upload")).toHaveLength(5);
    expect(calls.at(-1)).toContain("--draft=false");
    expect(calls.every((args) => !args.join(" ").includes("gguf"))).toBe(true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
it("rejects the wrong signing key before creating or publishing anything", async () => {
  const wrong = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }); let calls = 0;
  await expect(publishAppUpdate({ repo: "owner/repo", runId: "123", source: "a".repeat(40), platforms, artifacts: [], temporary: "unused", signingKey: wrong, publicKey, gh: async () => { calls++; } })).rejects.toThrow("does not match");
  expect(calls).toBe(0);
});
it("leaves an incomplete app update as a draft", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "stick-publish-incomplete-")); const calls = [];
  try {
    await expect(publishAppUpdate({ repo: "owner/repo", runId: "123", source: "a".repeat(40), platforms, artifacts: [], temporary, signingKey, publicKey, gh: async (...args) => { calls.push(args); return '{"isDraft":true}'; } })).rejects.toThrow("Missing app update");
    expect(calls.some((args) => args.includes("--draft=false"))).toBe(false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
