import { createPrivateKey, createHash, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updatePublicKey } from "../src/portable/update-key.ts";

export async function publishAppUpdate({ repo, runId, source, artifacts, platforms, temporary, signingKey, gh, publicKey = updatePublicKey }) {
  if (!signingKey) { throw new Error("STICK_UPDATE_SIGNING_KEY is required to publish the app update"); }
  const key = createPrivateKey(signingKey); const probe = Buffer.from("stick-ai-update-key-check");
  if (!verify(null, probe, publicKey, sign(null, probe, key))) { throw new Error("Update signing key does not match the app public key"); }
  const tag = `app-${runId}`;
  let existing;
  try { existing = JSON.parse(await gh("release", "view", tag, "--repo", repo, "--json", "isDraft")); }
  catch (error) { if (!/release not found|HTTP 404/i.test(String(error.stderr))) { throw error; } }
  if (existing && !existing.isDraft) { console.log(`App update already published: https://github.com/${repo}/releases/tag/${tag}`); return tag; }
  const notes = join(temporary, "app-update-notes.md");
  await writeFile(notes, `# Stick AI app update — GitHub workspaces + Max picker\n\nOpen your existing Stick AI app and choose **Check for updates**, then **Update and restart**. Your installed models and project files stay in place; these downloads contain no GGUF model weights.\n\nAfter starting the assistant, open **GitHub repository** to connect a public or private repo, work locally with Lite/Max, review changes and create or update a draft pull request on a separate branch. A session-only token with Contents and Pull requests write access is required for publishing. Saved workspaces survive updates; models run locally and tasks stop when the app closes. Repository programs and tests are not executed.\n\nThe welcome screen offers Lite + Max, Lite only and direct Max code generation. Under **Use a Max file already on your stick**, choose your single Max GGUF. It stays in its original location. Max requires at least 16 GiB RAM.\n\nThe assets below are signed updater payloads, not standalone ZIP installers. Complete first-install downloads with both model files are published separately as **Stick AI — Lite + Max**. Public downloads do not require a GitHub token.\n\nSource: ${source}. [Build checks](https://github.com/${repo}/actions/runs/${runId}).\n`);
  if (!existing) { await gh("release", "create", tag, "--repo", repo, "--target", source, "--title", "Stick AI app update — GitHub workspaces + Max picker", "--draft", "--prerelease", "--notes-file", notes); }
  const assets = [];
  for (const platform of platforms) {
    const artifact = artifacts.find((item) => item.name === `stick_ai-update-${platform}` && !item.expired);
    if (!artifact) { throw new Error(`Missing app update for ${platform}`); }
    const folder = join(temporary, `app-update-${platform}`);
    await gh("run", "download", runId, "--repo", repo, "--name", artifact.name, "--dir", folder);
    const name = `stick_ai-update-${platform}.gz`; const files = await readdir(folder);
    if (files.length !== 1 || files[0] !== name) { throw new Error("Unexpected app update artifact contents"); }
    const hash = createHash("sha256"); let size = 0;
    for await (const bytes of createReadStream(join(folder, name))) { hash.update(bytes); size += bytes.length; }
    if (!size || size > 512 * 1024 ** 2) { throw new Error("App update size is invalid"); }
    assets.push({ target: platform, name, size, sha256: hash.digest("hex") });
    await gh("release", "upload", tag, join(folder, name), "--repo", repo, "--clobber");
    await rm(folder, { recursive: true, force: true });
  }
  const payload = Buffer.from(JSON.stringify({ format: 1, repository: repo, sequence: Number(runId), source, assets }));
  const feed = join(temporary, "stick_ai-updates.json");
  await writeFile(feed, JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, key).toString("base64") }) + "\n");
  await gh("release", "upload", tag, feed, "--repo", repo, "--clobber");
  await gh("release", "edit", tag, "--repo", repo, "--notes-file", notes, "--draft=false");
  console.log(`Published app update: https://github.com/${repo}/releases/tag/${tag}`);
  return tag;
}
