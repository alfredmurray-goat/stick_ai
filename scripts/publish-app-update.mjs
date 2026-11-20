// App update releases are always private drafts (visible only to people with write access): sticks are sold preinstalled.
import { createPrivateKey, createHash, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { updatePublicKey } from "../src/portable/update-key.ts";
import { createUpdateHost, defaultFeedUrl, feedKey, publishedSequence } from "./update-host.mjs";

export async function publishAppUpdate({ repo, runId, source, artifacts, platforms, temporary, signingKey, gh, publicKey = updatePublicKey, host = createUpdateHost(), feedUrl = process.env.STICK_UPDATE_FEED || defaultFeedUrl, currentSequence = publishedSequence, tag = `app-${runId}`, ownRelease = true, universal }) {
  if (!signingKey) { throw new Error("STICK_UPDATE_SIGNING_KEY is required to publish the app update"); }
  const key = createPrivateKey(signingKey); const probe = Buffer.from("stick-ai-update-key-check");
  if (!verify(null, probe, publicKey, sign(null, probe, key))) { throw new Error("Update signing key does not match the app public key"); }
  // With ownRelease false the files go into a release the caller created (the single all-devices release),
  // and the caller writes its notes. `universal` is a local all-devices bundle added to the signed feed.
  const prefix = feedKey(feedUrl).replace(/stick_ai-updates\.json$/, "");
  if (!host) { console.log("R2 update host is not configured (CLOUDFLARE_API_TOKEN secret and R2_ACCOUNT_ID variable); sold sticks won't receive this update."); }
  let existing;
  try { existing = JSON.parse(await gh("release", "view", tag, "--repo", repo, "--json", "isDraft")); }
  catch (error) { if (!/release not found|HTTP 404/i.test(String(error.stderr))) { throw error; } }
  if (ownRelease && existing && !existing.isDraft) { console.log(`App update already published: https://github.com/${repo}/releases/tag/${tag}`); return tag; }
  const notes = join(temporary, "app-update-notes.md");
  await writeFile(notes, `# Stick AI app update — workspace, MCP + skills\n\nOpen your existing Stick AI app and choose **Check for updates**, then **Update and restart**. Your installed models and project files stay in place; these downloads contain no GGUF model weights.\n\nThe app has a rebuilt coding workspace: project sidebar, file editor, central conversation, and a live Thinking and Tool Activity panel. Thinking opens by default and shows reasoning as the model emits it; not every response emits separate reasoning. File reads, searches, writes, and Lite/Max handoffs are visible while they run. Approved changes stay resolved when the page reloads. Dark and light themes and keyboard shortcuts are included.\n\nOpen **MCP servers** to add local stdio programs or remote Streamable HTTP/SSE tool servers. Connections are explicit and every tool call needs approval. Headers and environment secrets are session-only. Open **Skills** to create/import SKILL.md packs, review project/user packs, or use /review-code, /fix-bug and /plan-feature. Changed packs need a fresh review. OAuth browser sign-in and automatic skill script execution are not included.\n\nAfter opening the workspace, open **GitHub repository** to connect a public or private repo, work locally with Lite/Max, review changes and create or update a draft pull request on a separate branch. A session-only token with Contents and Pull requests write access is required for publishing. Saved workspaces survive updates; models run locally and tasks stop when the app closes. Repository programs and tests are not executed.\n\nThe welcome screen offers Lite + Max, Lite only and direct Max code generation. Under **Use a Max file already on your stick**, choose your single Max GGUF. It stays in its original location. Max requires at least 16 GiB RAM.\n\nThe assets below are signed updater payloads, not standalone ZIP installers. Complete first-install downloads with both model files are published separately as **Stick AI — Lite + Max**. Public downloads do not require a GitHub token.\n\nSource: ${source}. [Build checks](https://github.com/${repo}/actions/runs/${runId}).\n`);
  if (ownRelease && !existing) { await gh("release", "create", tag, "--repo", repo, "--target", source, "--title", "Stick AI app update — workspace, MCP + skills", "--draft", "--prerelease", "--notes-file", notes); }
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
    if (host) { await host.put(join(folder, name), `${prefix}${runId}/${name}`, { contentType: "application/gzip", cacheControl: "public, max-age=31536000, immutable" }); }
    await rm(folder, { recursive: true, force: true });
  }
  if (universal) {
    const name = "stick_ai-update-universal.gz"; if (basename(universal) !== name) { throw new Error(`The all-devices update must be named ${name}`); }
    const hash = createHash("sha256"); let size = 0;
    for await (const bytes of createReadStream(universal)) { hash.update(bytes); size += bytes.length; }
    if (!size || size > 512 * 1024 ** 2) { throw new Error("All-devices update size is invalid"); }
    assets.push({ target: "universal", name, size, sha256: hash.digest("hex") });
    await gh("release", "upload", tag, universal, "--repo", repo, "--clobber");
    if (host) { await host.put(universal, `${prefix}${runId}/${name}`, { contentType: "application/gzip", cacheControl: "public, max-age=31536000, immutable" }); }
  }
  const payload = Buffer.from(JSON.stringify({ format: 1, repository: repo, sequence: Number(runId), source, assets }));
  const feed = join(temporary, "stick_ai-updates.json");
  await writeFile(feed, JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, key).toString("base64") }) + "\n");
  await gh("release", "upload", tag, feed, "--repo", repo, "--clobber");
  if (host) {
    // Never move sticks back to an older build, for example when an old run is re-run.
    const live = await currentSequence(feedUrl);
    if (live >= Number(runId)) { console.log(`Sticks already get build ${live}; leaving the update feed unchanged.`); }
    else { await host.put(feed, feedKey(feedUrl), { contentType: "application/json", cacheControl: "no-cache, max-age=0" }); console.log(`Sold sticks will now update to build ${runId}: ${feedUrl}`); }
  }
  if (!ownRelease) { return tag; }
  await gh("release", "edit", tag, "--repo", repo, "--notes-file", notes);
  console.log(`Private app update draft ready: https://github.com/${repo}/releases`);
  return tag;
}
