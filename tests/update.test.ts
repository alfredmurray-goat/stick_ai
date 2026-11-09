import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, lstat, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashFile, staticFiles, type Manifest } from "../src/portable/integrity.js";
import { buildUpdateBundle } from "../src/portable/update-package.js";
import { checkForUpdate, findUpdate, prepareUpdate, applyPreparedUpdate, githubResponse, readUpdateConfig } from "../src/portable/update.js";
import { safeUpdatePath, validateUpdateManifest, verifyFeed, type SignedFeed, type UpdateFeed } from "../src/portable/update-format.js";
import { targets } from "../src/portable/platform.js";

const roots: string[] = [];
const key = generateKeyPairSync("ed25519"); const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
const source = (sequence: number) => sequence.toString(16).padStart(40, "0");
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function packageFixture(root: string, sequence: number, model = "saved model bytes") {
  const files: Record<string, string> = {
    "app/update-config.json": JSON.stringify({ format: 1, target: "linux-x64", repository: "alfredmurray-goat/stick_ai", sequence, source: source(sequence) }),
    "app/stick-update.cjs": "trusted updater", "app/launcher.cjs": `app version ${sequence}`,
    "app/ui/index.html": "page", "app/ui/main.js": "ui", "app/ui/style.css": "style",
    "bin/linux-x64/node": "node", "bin/linux-x64/llama-server": "server", "stick-ai": `desktop ${sequence}`,
    "models/stellan-1-lite-q4_k_m.gguf": model, "README.txt": "readme", "start.sh": "launcher"
  };
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); }
  await mkdir(join(root, "app/project"), { recursive: true }); await mkdir(join(root, "logs"));
  const manifest: Manifest = { format: 1, nodeRelease: "24.22.1", llamaRelease: "v0.9.0", targets: ["linux-x64"], files: [] };
  for (const path of await staticFiles(root)) { manifest.files.push({ path, ...await hashFile(join(root, path)), executable: false }); }
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
function signed(feed: UpdateFeed): SignedFeed {
  const payload = Buffer.from(JSON.stringify(feed)); return { payload: payload.toString("base64"), signature: sign(null, payload, key.privateKey).toString("base64") };
}
async function fixture(model?: string) {
  const parent = await mkdtemp(join(tmpdir(), "stick-update-test-")); roots.push(parent);
  const root = join(parent, "Stick AI"); const next = join(parent, "new-package");
  await packageFixture(root, 1); const manifest = await packageFixture(next, 2, model);
  await writeFile(join(root, "app/project/keep.txt"), "my project"); await writeFile(join(root, "logs/keep.log"), "my logs");
  const bundle = join(parent, "update.gz"); await buildUpdateBundle(next, "linux-x64", bundle);
  const bytes = await readFile(bundle); const hash = await hashFile(bundle);
  const feed: UpdateFeed = { format: 1, repository: "alfredmurray-goat/stick_ai", sequence: 2, source: source(2), assets: targets.map((target) => ({ target, name: `stick_ai-update-${target}.gz`, ...hash })) };
  let envelope = signed(feed); const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    calls.push(url.toString());
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer private-token");
    if (url.pathname.endsWith("/releases")) { return Response.json([{ draft: false, assets: [{ id: 1, name: "stick_ai-updates.json" }, { id: 2, name: "stick_ai-update-linux-x64.gz", size: bytes.length }] }]); }
    if (url.pathname.endsWith("/1")) { return Response.json(envelope); }
    if (url.pathname.endsWith("/2")) { return new Response(bytes); }
    throw new Error("Unexpected download");
  }));
  return { root, parent, feed, manifest, calls, setEnvelope(value: SignedFeed) { envelope = value; } };
}
it("verifies the publisher signature and rejects altered, unsigned and replayed metadata", async () => {
  const f = await fixture(); const envelope = signed(f.feed);
  expect(verifyFeed(envelope, publicKey, f.feed.repository).sequence).toBe(2);
  expect(() => verifyFeed({ ...envelope, payload: Buffer.from(JSON.stringify({ ...f.feed, sequence: 999 })).toString("base64") }, publicKey, f.feed.repository)).toThrow("signature");
  expect(() => verifyFeed({ ...envelope, signature: "" }, publicKey, f.feed.repository)).toThrow("signature");
  const config = await readUpdateConfig(f.root);
  expect(await findUpdate({ ...config, sequence: 3 }, "private-token", new AbortController().signal, publicKey)).toBeUndefined();
  expect(f.calls.some((url) => url.endsWith("/2"))).toBe(false);
});
it("installs an app update while retaining model inodes, project changes and logs without model downloads", async () => {
  const f = await fixture(); const model = join(f.root, "models/stellan-1-lite-q4_k_m.gguf"); const inode = (await lstat(model)).ino;
  const work = await prepareUpdate(f.root, "private-token", new AbortController().signal, publicKey);
  expect(await readdir(join(work, "next"))).not.toContain("models");
  await writeFile(join(f.root, "app/project/keep.txt"), "latest work before restart");
  await applyPreparedUpdate(f.root, work, publicKey);
  expect(await readFile(join(f.root, "app/launcher.cjs"), "utf8")).toBe("app version 2");
  expect(await readFile(model, "utf8")).toBe("saved model bytes"); expect((await lstat(model)).ino).toBe(inode);
  expect(await readFile(join(f.root, "app/project/keep.txt"), "utf8")).toBe("latest work before restart");
  expect(await readFile(join(f.root, "logs/keep.log"), "utf8")).toBe("my logs");
  expect(await readFile(join(work, "previous/app/launcher.cjs"), "utf8")).toBe("app version 1");
  expect(f.calls.filter((url) => url.endsWith("/2"))).toHaveLength(1); expect(f.calls.every((url) => !url.includes("gguf"))).toBe(true);
});
it("refuses model-changing updates and cleans staging without altering the installed copy", async () => {
  const f = await fixture("different model weights");
  await expect(prepareUpdate(f.root, "private-token", new AbortController().signal, publicKey)).rejects.toThrow("different models");
  expect((await readdir(f.parent)).some((name) => name.startsWith(".Stick AI.update-"))).toBe(false);
  expect(await readFile(join(f.root, "models/stellan-1-lite-q4_k_m.gguf"), "utf8")).toBe("saved model bytes");
});
it("rejects corrupted staged files before replacing the app", async () => {
  const f = await fixture(); const work = await prepareUpdate(f.root, "private-token", new AbortController().signal, publicKey);
  await writeFile(join(work, "next/app/launcher.cjs"), "malicious changes");
  await expect(applyPreparedUpdate(f.root, work, publicKey)).rejects.toThrow("Changed staged update");
  expect(await readFile(join(f.root, "app/launcher.cjs"), "utf8")).toBe("app version 1");
});
it("rolls back moved models and projects when a transfer fails", async () => {
  const f = await fixture(); const work = await prepareUpdate(f.root, "private-token", new AbortController().signal, publicKey);
  const outside = join(f.parent, "outside"); await mkdir(outside); await writeFile(join(outside, "sentinel"), "untouched");
  await rm(join(f.root, "logs"), { recursive: true }); await symlink(outside, join(f.root, "logs"), process.platform === "win32" ? "junction" : "dir");
  await expect(applyPreparedUpdate(f.root, work, publicKey)).rejects.toThrow("Unsafe application data");
  expect(await readFile(join(f.root, "app/launcher.cjs"), "utf8")).toBe("app version 1");
  expect(await readFile(join(f.root, "models/stellan-1-lite-q4_k_m.gguf"), "utf8")).toBe("saved model bytes");
  expect(await readFile(join(f.root, "app/project/keep.txt"), "utf8")).toBe("my project");
  expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("untouched");
});
it("rejects traversal, reserved Windows paths, model injection and wrong architectures", async () => {
  for (const path of ["../outside", "/absolute", "C:/windows", "app/../../outside", "app\\evil", "app/CON", "app/file.", "app/a:b"]) { expect(safeUpdatePath(path)).toBe(false); }
  const f = await fixture();
  expect(() => validateUpdateManifest({ ...f.manifest, targets: ["windows-x64"] }, "linux-x64")).toThrow("match");
  expect(() => validateUpdateManifest({ ...f.manifest, files: [...f.manifest.files, { path: "models/evil.gguf", sha256: "0".repeat(64), size: 1, executable: false }] }, "linux-x64")).toThrow("Unexpected model");
});
it("strips private credentials on CDN redirects and rejects untrusted redirect hosts", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => { calls.push(init); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file?signature=ok" } }) : new Response("ok"); }));
  await githubResponse("https://api.github.com/repos/owner/repo/releases/assets/1", "secret", new AbortController().signal);
  expect((calls[0]!.headers as Record<string, string>).Authorization).toBe("Bearer secret"); expect((calls[1]!.headers as Record<string, string>).Authorization).toBeUndefined();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } })));
  await expect(githubResponse("https://api.github.com/repos/owner/repo/releases/assets/1", "secret", new AbortController().signal)).rejects.toThrow("Untrusted");
});
it("fails offline and private authentication checks without blocking app startup", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  expect((await checkForUpdate(f.root, "", new AbortController().signal)).state).toBe("offline");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  expect((await checkForUpdate(f.root, "", new AbortController().signal)).state).toBe("authentication");
});
