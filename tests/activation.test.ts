import { expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Activation, ActivationError, certificateFor, findSerial, mountFor, normaliseCode } from "../src/portable/activation.js";
import { webApp } from "../src/portable/web.js";
import { contextPlan, type ManagedEngine } from "../src/portable/engine.js";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const certify = (code: string, stick: string, key = pair.privateKey) => { const payload = Buffer.from(JSON.stringify({ v: 1, code, stick, at: "2026-11-21" })).toString("base64url"); return `${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`; };
const STICK = "a".repeat(64);

it("reads codes the way people type them and refuses anything else", () => {
  expect(normaliseCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
  expect(normaliseCode(" 0OIL 1234 5678 ")).toBe("001112345678");
  expect(normaliseCode("O0IL-1234-5678")).toBe("001112345678");
  expect(normaliseCode("UUUU-1234-5678")).toBe("");
  expect(normaliseCode("short")).toBe("");
});

it("accepts only certificates signed by the website, for this exact stick", () => {
  expect(certificateFor(certify("ABCDEFGHJKMN", STICK), publicKey)).toEqual({ code: "ABCDEFGHJKMN", stick: STICK });
  const forged = certify("ABCDEFGHJKMN", STICK, generateKeyPairSync("ed25519").privateKey);
  expect(certificateFor(forged, publicKey)).toBeUndefined();
  const [payload, signature] = certify("ABCDEFGHJKMN", STICK).split(".");
  const edited = Buffer.from(JSON.stringify({ v: 1, code: "ABCDEFGHJKMN", stick: "b".repeat(64) })).toString("base64url");
  expect(certificateFor(`${edited}.${signature}`, publicKey)).toBeUndefined();
  expect(certificateFor(`${payload}`, publicKey)).toBeUndefined();
});

it("finds the stick's USB serial in system_profiler output and the mount in Linux mountinfo", () => {
  const tree = { SPUSBDataType: [{ _items: [{ _name: "Hub", _items: [{ _name: "stick_ai 64GB", serial_num: "AA0012345", Media: [{ bsd_name: "disk4", volumes: [{ bsd_name: "disk4s1" }] }] }, { _name: "Mouse", serial_num: "MOUSE1" }] }] }] };
  expect(findSerial(tree, "disk4")).toBe("AA0012345");
  expect(findSerial(tree, "disk9")).toBe("");
  const mountinfo = "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n90 22 8:17 / /media/me/STICK\\040AI rw - exfat /dev/sdb1 rw\n";
  expect(mountFor(mountinfo, "/media/me/STICK AI/stellan")).toEqual({ mount: "/media/me/STICK AI", source: "/dev/sdb1" });
  expect(mountFor(mountinfo, "/home/me")).toEqual({ mount: "/", source: "/dev/sda1" });
});

it("activates once online, then works offline after a restart, and refuses a copied certificate on another stick", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-activation-"));
  try {
    const calls: unknown[] = [];
    const server = vi.fn(async (_url: string | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); calls.push(body); return new Response(JSON.stringify({ certificate: certify(body.code, body.stick) }), { status: 200 }); }) as unknown as typeof fetch;
    const first = new Activation(root, publicKey, "https://example.test/activate", async () => STICK, server);
    expect(first.required).toBe(true); expect(await first.check()).toBe(false);
    await first.activate("abcd-efgh-jkmn");
    expect(calls).toEqual([{ code: "ABCDEFGHJKMN", stick: STICK }]); expect(first.active).toBe(true);
    const offline = vi.fn(async () => { throw new Error("no network"); }) as unknown as typeof fetch;
    const restart = new Activation(root, publicKey, "https://example.test/activate", async () => STICK, offline);
    expect(await restart.check()).toBe(true); expect(offline).not.toHaveBeenCalled();
    const copy = new Activation(root, publicKey, "https://example.test/activate", async () => "c".repeat(64), offline);
    expect(await copy.check()).toBe(false);
    await expect(copy.activate("ABCD-EFGH-JKMN")).rejects.toThrow(/internet once/);
    const taken = new Activation(root, publicKey, "x", async () => "d".repeat(64), (async () => new Response(JSON.stringify({ error: "This code is already in use on another stick." }), { status: 409 })) as unknown as typeof fetch);
    await expect(taken.activate("ABCD-EFGH-JKMN")).rejects.toThrow("already in use on another stick");
    await expect(new Activation(root, publicKey, "x", async () => "", offline).activate("ABCD-EFGH-JKMN")).rejects.toBeInstanceOf(ActivationError);
    expect(await new Activation(root, "").check()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("holds the model back until the stick is activated, then starts it", async () => {
  const root = await mkdtemp(join(tmpdir(), "stick-activation-web-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const started: string[] = [];
  const engine = { active: null as string | null, baseUrl: "http://127.0.0.1:9", key: "k", plan: contextPlan(16 * 1024 ** 3), async start(model: string) { started.push(model); this.active = model; }, async stop() { this.active = null; } };
  const server = (async (_url: string | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return new Response(JSON.stringify(body.code === "ABCDEFGHJKMN" ? { certificate: certify(body.code, body.stick) } : { error: "This code isn't valid." }), { status: body.code === "ABCDEFGHJKMN" ? 200 : 404 }); }) as unknown as typeof fetch;
  const activation = new Activation(root, publicKey, "https://example.test/activate", async () => STICK, server);
  const app = await webApp({ root, engine: engine as unknown as ManagedEngine, activation, bytes: 16 * 1024 ** 3, choices: ["stellan-1-lite"], noSwap: true, report: vi.fn(), log: vi.fn(), stop: async () => {} });
  const url = new URL(app.url);
  const api = async (path: string, data?: object) => { const response = await fetch(url.origin + path, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, body: await response.json() as any }; };
  try {
    await app.start("stellan-1-lite");
    expect(app.awaitingActivation).toBe(true); expect(started).toEqual([]);
    expect((await api("/api/state")).body).toMatchObject({ phase: "activate", activation: { required: true, active: false } });
    expect((await api("/api/start", { model: "stellan-1-lite" })).status).toBe(409);
    const wrong = await api("/api/activate", { code: "ZZZZ-ZZZZ-ZZZZ" });
    expect(wrong).toEqual({ status: 400, body: { error: "This code isn't valid." } });
    expect((await api("/api/activate", { code: "abcd-efgh-jkmn" })).status).toBe(200);
    await vi.waitFor(async () => expect((await api("/api/state")).body.phase).toBe("ready"));
    expect(started).toEqual(["stellan-1-lite"]); expect(app.awaitingActivation).toBe(false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
