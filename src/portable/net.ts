import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { rootCertificates } from "node:tls";
import { writeFile } from "node:fs/promises";
import { nativeHostExecutable } from "./native-files.js";
import { hashFile } from "./integrity.js";

/**
 * Every internet request for GitHub sign-in, GitHub workspaces, updates and activation goes through appFetch.
 * With a verified Stellan-Host in the package, Host makes the request itself over Mbed TLS (`stellan-host --fetch`),
 * checking certificates against the roots bundled with the app; tokens pass through Host's memory only and are never
 * saved or logged. Without Host, Node's fetch is used as before.
 */
let current: typeof fetch = (input, init) => fetch(input, init);
export const appFetch: typeof fetch = (input, init) => current(input, init);
export function useHostNetwork(executable: string, roots: string): void { current = hostFetch(executable, roots); }
export function useNodeNetwork(): void { current = (input, init) => fetch(input, init); }

const limit = 1024 ** 3;
export function hostFetch(executable: string, roots: string): typeof fetch {
  return async (input, init = {}) => {
    const request = new Request(input, init);
    // Host never follows redirects: every caller here already handles them itself (redirect: "manual").
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const body = request.body ? Buffer.from(await request.arrayBuffer()).toString("utf8") : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { if (!["host", "connection", "content-length", "accept-encoding", "user-agent"].includes(name)) headers[name] = value; });
    const folder = await mkdtemp(join(tmpdir(), "stick-net-"));
    const file = join(folder, "body");
    const child = spawn(executable, ["--fetch", roots], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { out += text; });
    const closed = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", () => resolve()); });
    child.stdin.end(JSON.stringify({ method: request.method, url: request.url, headers, ...(body !== undefined ? { body } : {}), maxBytes: limit, timeoutMs: 60000, saveTo: file }) + "\n");
    try { await closed; } finally { signal?.removeEventListener("abort", abort); }
    if (signal?.aborted) { await rm(folder, { recursive: true, force: true }); throw signal.reason; }
    let reply: { status?: number; headers?: Record<string, string>; error?: string };
    try { reply = JSON.parse(out.trim()); } catch { await rm(folder, { recursive: true, force: true }); throw new TypeError("fetch failed"); }
    if (reply.error || !reply.status) { await rm(folder, { recursive: true, force: true }); throw new TypeError("fetch failed", { cause: new Error(reply.error ?? "No response") }); }
    if (request.redirect === "error" && reply.status >= 300 && reply.status < 400) { await rm(folder, { recursive: true, force: true }); throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); }
    const empty = request.method === "HEAD" || [101, 204, 205, 304].includes(reply.status);
    let stream: ReadableStream<Uint8Array> | null = null;
    if (empty) { await rm(folder, { recursive: true, force: true }); }
    else {
      const node = createReadStream(file);
      const cleanup = () => { void rm(folder, { recursive: true, force: true }); };
      node.on("close", cleanup);
      stream = Readable.toWeb(node) as ReadableStream<Uint8Array>;
    }
    const response = new Response(stream, { status: reply.status, headers: reply.headers ?? {} });
    Object.defineProperty(response, "url", { value: request.url });
    return response;
  };
}
/** The trusted roots for Host: the package's own file when present, otherwise the same roots Node trusts today. */
export async function trustedRoots(packaged: string | undefined): Promise<string> {
  if (packaged) { return packaged; }
  const folder = await mkdtemp(join(tmpdir(), "stick-roots-"));
  const file = join(folder, "roots.pem");
  await writeFile(file, rootCertificates.join("\n") + "\n", { mode: 0o600 });
  return file;
}
/** Switches this process's internet requests to Host when the package has a Stellan-Host matching its manifest. */
export async function enableHostNetwork(root: string, log: (error: unknown) => void = () => undefined): Promise<boolean> {
  try {
    if (process.env.STICK_NETWORK_ON_NODE === "1") { return false; }
    const host = nativeHostExecutable(root);
    if (!host || (await hashFile(host.executable)).sha256 !== host.sha256) { return false; }
    useHostNetwork(host.executable, await trustedRoots(undefined));
    return true;
  } catch (error) { log(error); return false; }
}
