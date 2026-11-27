import { afterAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Activation, findSerial, modelNames, mountFor, stickIdentity } from "../src/portable/activation.js";

// Host's stick fingerprint and offline activation check (src/identity.cpp) against activation.ts. The fingerprint
// must be identical, or sticks that are already activated would stop being recognised.
const host = process.env.STELLAN_TEST_HOST ?? resolve(`native-host-app/${process.platform === "win32" ? "Release/stellan-host.exe" : "stellan-host"}`);
const ready = existsSync(host);
if (process.env.STELLAN_REQUIRE_NATIVE_HOST === "1" && !ready) { throw new Error(`The native host is missing (${host})`); }
const run = (args: string[], input = "") => spawnSync(host, args, { input, encoding: "utf8" }).stdout;
const folders: string[] = [];
afterAll(async () => { for (const folder of folders) { await rm(folder, { recursive: true, force: true }); } });

it.skipIf(!ready)("fingerprints the stick (or this disk) exactly as the app does", async () => {
  const roots = [process.cwd(), tmpdir(), resolve("/"), join(process.cwd(), "src")];
  for (const root of roots) {
    expect(JSON.parse(run(["--stick-identity", root])).identity, root).toBe(await stickIdentity(root));
  }
  expect(JSON.parse(run(["--stick-identity", join(tmpdir(), "no-such-folder-here")])).identity).toBe("");
});

it.skipIf(!ready)("reads mount tables and USB device trees exactly as the app does", () => {
  const mountinfo = [
    "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
    "40 22 8:17 / /media/me/STICK\\040AI rw,nosuid shared:2 - vfat /dev/sdb1 rw,uid=1000",
    "41 22 8:18 / /media/me/STICK rw shared:3 - exfat /dev/sdc1 rw",
    "42 22 0:5 / /proc rw - proc proc rw", "broken line", "", "43 22 0:6 / /media/me/STICK/inner rw - tmpfs tmpfs rw",
    "44 22 8:33 / /mnt/x rw -  /dev/odd rw"
  ].join("\n");
  const paths = ["/", "/home/me", "/media/me/STICK AI", "/media/me/STICK AI/stellan", "/media/me/STICKY", "/media/me/STICK/a", "/media/me/STICK/inner/b", "/proc/1", "/mnt/x/y", "relative"];
  const tree = { SPUSBDataType: [{ _name: "hub", serial_num: "  ", _items: [{ _name: "Stick", serial_num: "ab 12 cd", Media: [{ bsd_name: "disk4", volumes: [{ bsd_name: "disk4s1" }] }] }, { _name: "Other", serial_num: "ZZ", Media: [{ bsd_name: "disk5" }] }] }, { bsd_name: "disk9" }] };
  const disks = ["disk4", "disk4s1", "disk5", "disk9", "disk6", ""];
  const lines = [...paths.map((path) => JSON.stringify({ mountinfo, path })), ...disks.map((disk) => JSON.stringify({ tree, disk }))];
  const replies = run(["--identity-check"], lines.join("\n") + "\n").trim().split("\n").map((line) => JSON.parse(line));
  expect(replies).toEqual([...paths.map((path) => mountFor(mountinfo, path) ?? null), ...disks.map((disk) => findSerial(tree, disk))]);
});

it.skipIf(!ready)("checks saved activations offline exactly as the app does", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const other = generateKeyPairSync("ed25519");
  const certificate = (payload: unknown, signer = privateKey) => { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${body}.${sign(null, Buffer.from(body), signer).toString("base64url")}`; };
  const wrap = (modelKey: Buffer, stick: string, code: string) => {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", Buffer.from(stick, "hex"), "stick-ai-model-keys", code, 32)), iv);
    return Buffer.concat([iv, cipher.update(modelKey), cipher.final(), cipher.getAuthTag()]).toString("base64");
  };
  // Inside the checkout, which sits on the runner's real disk (temporary folders can be on volumes with no ID).
  const root = await mkdtemp(join(process.cwd(), ".stick-activation-native-")); folders.push(root);
  const stick = await stickIdentity(root); const code = "ABCDEFGHJKMN";
  // Where this disk has a serial or volume ID the activated path (keys unwrapped) is covered too; where it has none,
  // both sides must treat every file as "not activated".
  console.log(`Stick fingerprint on this ${process.platform} runner: ${stick ? "present" : "none"}`);
  const lite = randomBytes(32), max = randomBytes(32);
  const good = certificate({ v: 1, code, stick });
  const files: [string, string | undefined][] = [
    ["none", undefined], ["not json", "{oops"], ["no certificate", "{}"],
    ["genuine with keys", JSON.stringify({ format: 1, certificate: good, keys: { [modelNames[0]]: wrap(lite, stick, code), [modelNames[1]]: wrap(max, stick, code) } })],
    ["genuine without keys", JSON.stringify({ format: 1, certificate: good })],
    ["keys for another code", JSON.stringify({ format: 1, certificate: good, keys: { [modelNames[0]]: wrap(lite, stick, "ZZZZZZZZZZZZ"), [modelNames[1]]: "bad" } })],
    ["another stick", JSON.stringify({ format: 1, certificate: certificate({ v: 1, code, stick: "ab".repeat(32) }) })],
    ["signed by someone else", JSON.stringify({ format: 1, certificate: certificate({ v: 1, code, stick }, other.privateKey) })],
    ["version 2", JSON.stringify({ format: 1, certificate: certificate({ v: 2, code, stick }) })],
    ["tampered", JSON.stringify({ format: 1, certificate: good.replace(/^./, (c) => (c === "e" ? "f" : "e")) })],
    ["three parts", JSON.stringify({ format: 1, certificate: good + ".x" })],
    ["number certificate", JSON.stringify({ format: 1, certificate: 5 })]
  ];
  for (const [name, content] of files) {
    await rm(join(root, "logs"), { recursive: true, force: true });
    if (content !== undefined) { await mkdir(join(root, "logs"), { recursive: true }); await writeFile(join(root, "logs", "activation.json"), content); }
    for (const publicKeyText of [key, ""]) {
      const app = new Activation(root, publicKeyText, "https://unused.invalid", stickIdentity);
      const expected = { active: await app.check(), keys: Object.fromEntries(modelNames.flatMap((model) => { const k = app.modelKey(model); return k ? [[model, k.toString("base64")]] : []; })) };
      expect(JSON.parse(run(["--activation-check", root, publicKeyText])), `${name} ${publicKeyText ? "" : "(no key)"}`).toEqual(expected);
      if (stick && publicKeyText && name === "genuine with keys") { expect(expected).toEqual({ active: true, keys: { [modelNames[0]]: lite.toString("base64"), [modelNames[1]]: max.toString("base64") } }); }
    }
  }
});
