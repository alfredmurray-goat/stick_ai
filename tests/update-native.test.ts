import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { hashFile, staticFiles, type Manifest } from "../src/portable/integrity.js";
import { buildUpdateBundle, extractUpdateBundle } from "../src/portable/update-package.js";
import { targets } from "../src/portable/platform.js";

// The native updater (stellan-host --update) against the same kind of stick install as tests/update.test.ts. It runs
// the test build (stellan-update-testing), which differs from the shipped one only in accepting a test signing key
// and a feed on a local port.
const exe = process.platform === "win32" ? "Release/stellan-update-testing.exe" : "stellan-update-testing";
const updater = process.env.STELLAN_TEST_UPDATER ?? resolve(`native-host-app/${exe}`);
const hasOpenssl = (() => { try { execFileSync("openssl", ["version"]); return true; } catch { return false; } })();
const ready = existsSync(updater) && hasOpenssl;
// CI sets this so a missing build fails instead of skipping.
if (process.env.STELLAN_REQUIRE_NATIVE_HOST === "1" && !ready) { throw new Error(`The native updater test build is missing (${updater}) or openssl is unavailable`); }
const key = generateKeyPairSync("ed25519"); const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
const source = (sequence: number) => sequence.toString(16).padStart(40, "0");
let dir = "", server: Server | undefined, port = 0, envelope = "", bundle = Buffer.alloc(0);
const routes = new Map<string, () => Buffer | string>();

beforeAll(async () => {
  if (!ready) return;
  dir = await mkdtemp(join(tmpdir(), "stick-native-update-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(dir, "tls.key"), "-out", join(dir, "tls.pem")], { stdio: "ignore" });
  server = createServer({ key: readFileSync(join(dir, "tls.key")), cert: readFileSync(join(dir, "tls.pem")) }, (request, response) => {
    const route = routes.get(request.url ?? "");
    if (!route) { response.writeHead(404); response.end(); return; }
    response.writeHead(200); response.end(route());
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done)); port = (server!.address() as AddressInfo).port;
}, 30000);
afterAll(async () => { server?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

async function packageFixture(root: string, sequence: number, feed: string): Promise<Manifest> {
  const files: Record<string, string> = {
    "app/update-config.json": JSON.stringify({ format: 1, target: "linux-x64", repository: "alfredmurray-goat/stick_ai", sequence, source: source(sequence), feed }),
    "app/stick-update.cjs": "trusted updater", "app/launcher.cjs": `app version ${sequence}`,
    "app/ui/index.html": "page", "app/ui/main.js": "ui", "app/ui/style.css": "style",
    "bin/linux-x64/node": "node", "bin/linux-x64/llama-server": "server", "stick-ai": `desktop ${sequence}`,
    "models/stellan-1-lite-q4_k_m.gguf": "saved model bytes", "README.txt": "readme", "start.sh": "launcher", "app/trusted-roots.pem": await readFile(join(dir, "tls.pem"), "utf8")
  };
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); }
  await mkdir(join(root, "app/project"), { recursive: true }); await mkdir(join(root, "logs"));
  const manifest: Manifest = { format: 1, nodeRelease: "24.22.1", llamaRelease: "v0.9.0", targets: ["linux-x64"], files: [] };
  for (const path of await staticFiles(root)) { manifest.files.push({ path, ...await hashFile(join(root, path)), executable: false }); }
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
async function fixture(name: string) {
  const parent = join(dir, name); await mkdir(parent);
  const feed = `https://localhost:${port}/${name}/stick_ai-updates.json`;
  const root = join(parent, "Stick AI"), next = join(parent, "new-package");
  await packageFixture(root, 1, feed); await packageFixture(next, 2, feed);
  await writeFile(join(root, "app/project/keep.txt"), "my project"); await writeFile(join(root, "logs/keep.log"), "my logs");
  const file = join(parent, "update.gz"); await buildUpdateBundle(next, "linux-x64", file);
  bundle = await readFile(file); const hash = await hashFile(file);
  const payload = Buffer.from(JSON.stringify({ format: 1, repository: "alfredmurray-goat/stick_ai", sequence: 2, source: source(2), assets: targets.map((target) => ({ target, name: `stick_ai-update-${target}.gz`, ...hash })) }));
  envelope = JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, key.privateKey).toString("base64") });
  const own = { envelope, bundle };
  routes.set(`/${name}/stick_ai-updates.json`, () => own.envelope);
  routes.set(`/${name}/2/stick_ai-update-linux-x64.gz`, () => own.bundle);
  return { parent, root, next, file, own };
}
// Asynchronous on purpose: the feed server runs in this process and must keep answering while the updater waits.
async function run(args: string[], env: Record<string, string> = {}, command = updater): Promise<{ status: number | null; output: any }> {
  const child = spawn(command, ["--update", ...args], { env: { ...process.env, STELLAN_UPDATE_TEST_KEY: publicKey, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; }); child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  child.stdin.end(JSON.stringify({ token: "" }) + "\n");
  const status = await new Promise<number | null>((done) => child.once("close", done));
  if (stderr) { console.log(stderr); }
  return { status, output: stdout.trim() ? JSON.parse(stdout) : undefined };
}
function deadPid(): number { const child = spawnSync(process.execPath, ["-e", "0"]); return child.pid!; }
async function installer() {
  const temporary = await mkdtemp(join(tmpdir(), "stick-ai-updater-"));
  const copy = join(temporary, process.platform === "win32" ? "stellan-host.exe" : "stellan-host"); await copyFile(updater, copy);
  if (process.platform !== "win32") { execFileSync("chmod", ["755", copy]); }
  return { temporary, copy };
}

it.skipIf(!ready)("checks, prepares and installs a signed update, keeping models, projects and logs", async () => {
  const f = await fixture("good");
  expect(await run(["--root", f.root, "--check"])).toEqual({ status: 0, output: { state: "available", sequence: 2, bytes: f.own.bundle.length, message: "An app update is ready. Your models and projects stay here." } });
  const prepared = await run(["--root", f.root, "--prepare", "--parent", String(process.pid)]);
  expect(prepared.status).toBe(0); expect(prepared.output.state).toBe("prepared");
  const work = prepared.output.work as string;
  // The staged manifest is byte-for-byte what the app's own extraction writes.
  const reference = join(f.parent, "reference"); await mkdir(reference);
  await extractUpdateBundle(f.file, reference, "linux-x64", new AbortController().signal);
  expect(await readFile(join(work, "next/manifest.json"), "utf8")).toBe(await readFile(join(reference, "manifest.json"), "utf8"));
  expect(await staticFiles(join(work, "next"))).toEqual(await staticFiles(reference));
  const { temporary, copy } = await installer(); const log = join(f.parent, "relaunch.txt");
  expect((await run(["--apply", "--root", f.root, "--work", work, "--parent", String(deadPid()), "--temporary", temporary], { STELLAN_UPDATE_TEST_RELAUNCH: log }, copy)).status).toBe(0);
  expect(await readFile(join(f.root, "app/launcher.cjs"), "utf8")).toBe("app version 2");
  expect(await readFile(join(f.root, "app/project/keep.txt"), "utf8")).toBe("my project");
  expect(await readFile(join(f.root, "logs/keep.log"), "utf8")).toBe("my logs");
  expect(await readFile(join(f.root, "models/stellan-1-lite-q4_k_m.gguf"), "utf8")).toBe("saved model bytes");
  expect(JSON.parse(await readFile(join(work, "rollback.json"), "utf8")).installed).toBe(2);
  expect((await readFile(log, "utf8")).split("\n").slice(1, 3)).toEqual(["--cleanup-update", temporary]);
  expect((await run(["--root", f.root, "--check"])).output.state).toBe("current");
}, 60000);

it.skipIf(!ready)("rejects forged feeds and rolls back a download that changed after preparing", async () => {
  const f = await fixture("forged");
  const signed = JSON.parse(f.own.envelope);
  f.own.envelope = JSON.stringify({ ...signed, payload: Buffer.from(Buffer.from(signed.payload, "base64").toString().replace('"sequence":2', '"sequence":9')).toString("base64") });
  expect((await run(["--root", f.root, "--check"])).output.state).toBe("offline");
  expect((await run(["--root", f.root, "--check"], { STELLAN_UPDATE_TEST_KEY: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() })).output.state).toBe("offline");
  f.own.envelope = JSON.stringify(signed);
  const prepared = await run(["--root", f.root, "--prepare", "--parent", String(process.pid)]); const work = prepared.output.work as string;
  await writeFile(join(work, "download.gz"), Buffer.concat([await readFile(join(work, "download.gz")), Buffer.from("x")]));
  const { temporary, copy } = await installer(); const log = join(f.parent, "relaunch.txt");
  expect((await run(["--apply", "--root", f.root, "--work", work, "--parent", String(deadPid()), "--temporary", temporary], { STELLAN_UPDATE_TEST_RELAUNCH: log }, copy)).status).toBe(0);
  expect(await readFile(join(f.root, "app/launcher.cjs"), "utf8")).toBe("app version 1");
  expect(await readFile(join(work, "update.log"), "utf8")).toContain("could not be applied");
  expect(await readFile(log, "utf8")).toContain("--update-failed");
  // The installer refuses to run from anywhere but its own temporary copy.
  expect((await run(["--apply", "--root", f.root, "--work", work, "--parent", String(deadPid()), "--temporary", temporary])).status).toBe(1);
}, 60000);

it.skipIf(!ready)("reports copies without update settings as unsupported", async () => {
  const f = await fixture("unsupported");
  await rm(join(f.root, "app/update-config.json"));
  expect((await run(["--root", f.root, "--check"])).output.state).toBe("unsupported");
}, 60000);

// The all-devices stick sold in shops: the apps sit at the top of the stick, everything else in `stellan/`.
it.skipIf(!ready)("updates an all-devices stick, swapping the apps beside the stellan folder", async () => {
  const parent = join(dir, "all-devices"); const stick = join(parent, "stick"); const root = join(stick, "stellan"); const next = join(parent, "next");
  const feed = `https://localhost:${port}/all-devices/stick_ai-updates.json`;
  const apps = { "Stick AI.app/Contents/MacOS/stick-ai": "mac app", "Stick AI.exe": "windows app", "stick-ai": "linux app" };
  async function write(folder: string, sequence: number, withApps: boolean) {
    const files: Record<string, string> = {
      "app/update-config.json": JSON.stringify({ format: 1, target: "universal", repository: "alfredmurray-goat/stick_ai", sequence, source: source(sequence), feed }),
      "app/stick-update.cjs": "trusted updater", "app/launcher.cjs": `app version ${sequence}`, "app/ui/index.html": "page", "app/ui/main.js": "ui", "app/ui/style.css": "style",
      "models/stellan-1-lite-q4_k_m.gguf": "saved model bytes", "README.txt": "readme", "Start.command": "mac", "Start.bat": "windows", "start.sh": "linux",
      "app/trusted-roots.pem": await readFile(join(dir, "tls.pem"), "utf8")
    };
    for (const target of targets) { const exe = target === "windows-x64" ? ".exe" : ""; files[`bin/${target}/node${exe}`] = "node"; files[`bin/${target}/llama-server${exe}`] = "server"; }
    if (withApps) { for (const [path, content] of Object.entries(apps)) { files[path] = `${content} ${sequence}`; } }
    for (const [path, content] of Object.entries(files)) { await mkdir(join(folder, path, ".."), { recursive: true }); await writeFile(join(folder, path), content); }
    const manifest: Manifest = { format: 1, nodeRelease: "24.22.1", llamaRelease: "v0.9.0", targets: [...targets], files: [] };
    for (const path of await staticFiles(folder)) { manifest.files.push({ path, ...await hashFile(join(folder, path)), executable: false }); }
    await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  await write(root, 1, false); await write(next, 2, true);
  for (const [path, content] of Object.entries(apps)) { await mkdir(join(stick, path, ".."), { recursive: true }); await writeFile(join(stick, path), `${content} 1`); }
  await mkdir(join(root, "app/project"), { recursive: true }); await writeFile(join(root, "app/project/keep.txt"), "my project");
  const file = join(parent, "update.gz"); await buildUpdateBundle(next, "universal", file);
  const bytes = await readFile(file); const hash = await hashFile(file);
  const payload = Buffer.from(JSON.stringify({ format: 1, repository: "alfredmurray-goat/stick_ai", sequence: 2, source: source(2), assets: [...targets, "universal"].map((target) => ({ target, name: `stick_ai-update-${target}.gz`, ...hash })) }));
  routes.set("/all-devices/stick_ai-updates.json", () => JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, key.privateKey).toString("base64") }));
  routes.set("/all-devices/2/stick_ai-update-universal.gz", () => bytes);
  const prepared = await run(["--root", root, "--prepare", "--parent", String(process.pid)]);
  expect(prepared.output.state).toBe("prepared");
  const { temporary, copy } = await installer(); const log = join(parent, "relaunch.txt");
  expect((await run(["--apply", "--root", root, "--work", prepared.output.work, "--parent", String(deadPid()), "--temporary", temporary], { STELLAN_UPDATE_TEST_RELAUNCH: log }, copy)).status).toBe(0);
  for (const [path, content] of Object.entries(apps)) { expect(await readFile(join(stick, path), "utf8")).toBe(`${content} 2`); expect(existsSync(join(root, path))).toBe(false); }
  expect(await readFile(join(root, "app/launcher.cjs"), "utf8")).toBe("app version 2");
  expect(await readFile(join(root, "app/project/keep.txt"), "utf8")).toBe("my project");
  const installed = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  expect(installed.files.some((record) => record.path === "stick-ai")).toBe(false);
  expect((await readFile(log, "utf8")).split("\n")[0]).toBe(stick);
}, 60000);
