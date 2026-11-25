import { appFetch } from "./net.js";
// One-time activation. A sold stick is activated once with the code printed in its box: the app sends the
// code and a fingerprint of the stick to the website, which ties the code to that stick and returns a
// certificate signed with Ed25519. The certificate is saved on the stick and checked offline at every start
// with the public key below, so the internet is needed only that first time.
//
// The fingerprint is a SHA-256 of the stick's USB serial number, which every operating system reads the same
// way, so copying the files to another stick does not carry the activation with it. When a computer can't
// read the serial, the volume's ID is used instead; the website allows a few such "seats" per code so one
// stick seen by Mac, Windows and Linux still works. This stops casual copying, not a determined expert: the
// app is open source. Builds without a public key (development and tests) never ask for activation.
import { createDecipheriv, createHash, createPublicKey, hkdfSync, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, writeFile, rename, mkdir } from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";
import { promisify } from "node:util";

/** Ed25519 public key (SPKI, base64) from the website's activation desk. Empty = activation not required. */
export const activationPublicKey = "";
export const activationServer = "https://stick-ai.localilabs.com/api/activate";
const exec = promisify(execFile);

export class ActivationError extends Error { constructor(message: string) { super(message); this.name = "ActivationError"; } }

/** "abcd-efgh-jkmn" and look-alikes (O→0, I/L→1) become "ABCDEFGHJKMN"; anything else is "". Matches the website. */
export function normaliseCode(value: string): string {
  const code = value.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return code.length === 12 && /^[0-9A-HJKMNP-TV-Z]+$/.test(code) ? code : "";
}

// ---------- Which stick is this? ----------
const clean = (value: string): string => value.replace(/\s+/g, "").toUpperCase();
export function findSerial(tree: unknown, disk: string): string {
  // system_profiler lists USB devices with their serial and, somewhere below, the disks they carry.
  let found = "";
  const walk = (node: unknown, serial: string): boolean => {
    if (Array.isArray(node)) { return node.some((item) => walk(item, serial)); }
    if (!node || typeof node !== "object") { return false; }
    const item = node as Record<string, unknown>;
    const own = typeof item.serial_num === "string" && item.serial_num.trim() ? item.serial_num : serial;
    if (item.bsd_name === disk && own) { found = own; return true; }
    return Object.values(item).some((value) => walk(value, own));
  };
  walk(tree, "");
  return found;
}
export function mountFor(mountinfo: string, path: string): { mount: string; source: string } | undefined {
  let best: { mount: string; source: string } | undefined;
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - "); if (!left || !right) { continue; }
    const mount = left.split(" ")[4]?.replace(/\\040/g, " "); const source = right.split(" ")[1];
    if (!mount || !source || !(path === mount || path.startsWith(mount.endsWith("/") ? mount : mount + "/"))) { continue; }
    if (!best || mount.length > best.mount.length) { best = { mount, source }; }
  }
  return best;
}
async function linuxIdentity(path: string): Promise<string> {
  const mount = mountFor(await readFile("/proc/self/mountinfo", "utf8"), path);
  if (!mount?.source.startsWith("/dev/")) { return ""; }
  const device = await realpath(mount.source).catch(() => mount.source);
  // Walk up from the partition in sysfs to the USB device, which has a serial file.
  let dir = await realpath(join("/sys/class/block", basename(device))).catch(() => "");
  for (let i = 0; dir && i < 12; i++, dir = dirname(dir)) {
    const serial = await readFile(join(dir, "serial"), "utf8").catch(() => "");
    const vendor = await readFile(join(dir, "idVendor"), "utf8").catch(() => "");
    if (serial.trim() && vendor.trim()) { return `usb:${clean(serial)}`; }
  }
  for (const uuid of await readdir("/dev/disk/by-uuid").catch(() => [] as string[])) {
    if (await realpath(join("/dev/disk/by-uuid", uuid)).catch(() => "") === device) { return `volume:${clean(uuid)}`; }
  }
  return "";
}
async function macIdentity(path: string): Promise<string> {
  const info = (await exec("/usr/sbin/diskutil", ["info", path], { timeout: 8000 })).stdout;
  const whole = /Part of Whole:\s+(\S+)/.exec(info)?.[1] ?? "";
  for (const type of ["SPUSBDataType", "SPUSBHostDataType"]) {
    try { const serial = whole && findSerial(JSON.parse((await exec("/usr/sbin/system_profiler", [type, "-json"], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })).stdout), whole); if (serial) { return `usb:${clean(serial)}`; } } catch {}
  }
  const volume = /Volume UUID:\s+(\S+)/.exec(info)?.[1] ?? /Disk \/ Partition UUID:\s+(\S+)/.exec(info)?.[1] ?? "";
  return volume ? `volume:${clean(volume)}` : "";
}
async function windowsIdentity(path: string): Promise<string> {
  const letter = /^([A-Za-z]):/.exec(parse(path).root)?.[1]?.toUpperCase(); if (!letter) { return ""; }
  const system = process.env.SystemRoot ?? "C:\\Windows";
  try {
    const serial = (await exec(join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `(Get-Partition -DriveLetter ${letter} | Get-Disk).SerialNumber`], { timeout: 15000, windowsHide: true })).stdout.trim();
    if (serial) { return `usb:${clean(serial)}`; }
  } catch {}
  try { const volume = /([0-9A-F]{4}-[0-9A-F]{4})/i.exec((await exec(join(system, "System32", "cmd.exe"), ["/d", "/c", `vol ${letter}:`], { timeout: 8000, windowsHide: true })).stdout)?.[1]; if (volume) { return `volume:${clean(volume)}`; } } catch {}
  return "";
}
/** A SHA-256 fingerprint of the stick the app runs from, or "" if this computer can't tell. */
export async function stickIdentity(root: string, platform = process.platform): Promise<string> {
  const path = await realpath(root);
  const raw = await (platform === "linux" ? linuxIdentity(path) : platform === "darwin" ? macIdentity(path) : platform === "win32" ? windowsIdentity(path) : Promise.resolve("")).catch(() => "");
  return raw ? createHash("sha256").update(`stick-ai:${raw}`).digest("hex") : "";
}

// ---------- Certificates ----------
export function certificateFor(certificate: string, publicKey: string): { code: string; stick: string } | undefined {
  const [payload, signature, extra] = certificate.split(".");
  if (!payload || !signature || extra !== undefined || !publicKey) { return undefined; }
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))) { return undefined; }
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return value.v === 1 && typeof value.code === "string" && typeof value.stick === "string" ? { code: value.code, stick: value.stick } : undefined;
  } catch { return undefined; }
}

// Model keys arrive with the certificate, wrapped with a key derived from this stick's fingerprint and the
// code, so copying activation.json to another stick doesn't hand over the keys (see model-lock.ts).
export const modelNames = ["stellan-1-lite", "stellan-1-max"] as const;
export function unwrapModelKey(wrapped: string, stick: string, code: string): Buffer | undefined {
  try {
    const sealed = Buffer.from(wrapped, "base64"); if (sealed.length !== 12 + 32 + 16) { return undefined; }
    const wrapping = Buffer.from(hkdfSync("sha256", Buffer.from(stick, "hex"), "stick-ai-model-keys", code, 32));
    const decipher = createDecipheriv("aes-256-gcm", wrapping, sealed.subarray(0, 12)); decipher.setAuthTag(sealed.subarray(44));
    return Buffer.concat([decipher.update(sealed.subarray(12, 44)), decipher.final()]);
  } catch { return undefined; }
}
export class Activation {
  #active = false; #identity: string | undefined; #keys = new Map<string, Buffer>();
  constructor(private readonly root: string, private readonly publicKey = activationPublicKey, private readonly server = activationServer, private readonly identify: (root: string) => Promise<string> = stickIdentity, private readonly fetcher: typeof fetch = appFetch) {}
  get required(): boolean { return Boolean(this.publicKey); }
  get active(): boolean { return !this.required || this.#active; }
  private get file(): string { return join(this.root, "logs", "activation.json"); }
  async #id(): Promise<string> { this.#identity ??= await this.identify(this.root); return this.#identity; }
  /** Checks the saved certificate offline; true when this stick is activated (or activation isn't required). */
  async check(): Promise<boolean> {
    if (!this.required) { return true; }
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as { certificate?: unknown };
      const cert = typeof saved.certificate === "string" ? certificateFor(saved.certificate, this.publicKey) : undefined;
      const id = await this.#id();
      this.#active = Boolean(cert && id && cert.stick === id);
      if (this.#active && cert) { this.#readKeys((saved as { keys?: unknown }).keys, cert); }
    } catch { this.#active = false; }
    return this.#active;
  }
  #readKeys(keys: unknown, cert: { code: string; stick: string }): void {
    this.#keys.clear();
    if (!keys || typeof keys !== "object") { return; }
    for (const model of modelNames) { const wrapped = (keys as Record<string, unknown>)[model]; const key = typeof wrapped === "string" ? unwrapModelKey(wrapped, cert.stick, cert.code) : undefined; if (key) { this.#keys.set(model, key); } }
  }
  /** The key that unlocks this stick's locked copy of a model, once activated. */
  modelKey(model: string): Buffer | undefined { return this.#keys.get(model); }
  /** Activates this stick online with the printed code and saves the certificate on the stick. */
  async activate(input: string): Promise<void> {
    const code = normaliseCode(input);
    if (!code) { throw new ActivationError("That doesn't look like an activation code. It has 12 letters and numbers, like ABCD-EFGH-JKMN."); }
    const stick = await this.#id();
    if (!stick) { throw new ActivationError("This computer couldn't identify the stick. Try another USB port, or another computer, then try again."); }
    let response: Response;
    try { response = await this.fetcher(this.server, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, stick }), signal: AbortSignal.timeout(20000) }); }
    catch { throw new ActivationError("Activation needs the internet once. Connect to Wi-Fi and try again."); }
    let reply: { certificate?: unknown; error?: unknown; keys?: unknown } = {};
    try { reply = await response.json() as typeof reply; } catch {}
    if (!response.ok) { throw new ActivationError(typeof reply.error === "string" && reply.error.length < 400 ? reply.error : "Activation didn't work. Try again in a minute."); }
    const certificate = typeof reply.certificate === "string" ? reply.certificate : "";
    const cert = certificateFor(certificate, this.publicKey);
    if (!cert || cert.stick !== stick || cert.code !== code) { throw new ActivationError("The activation reply couldn't be checked. Try again in a minute."); }
    await mkdir(dirname(this.file), { recursive: true });
    const keys = reply.keys && typeof reply.keys === "object" ? reply.keys : undefined;
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ format: 1, certificate, ...(keys ? { keys } : {}) }) + "\n", { mode: 0o600 }); await rename(temporary, this.file);
    this.#active = true; this.#readKeys(keys, cert);
  }
}
