import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // Host never follows redirects: every caller here already handles them itself (redirect: "manual" or "error").
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const body = request.body ? Buffer.from(await request.arrayBuffer()).toString("utf8") : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { if (!["host", "connection", "content-length", "accept-encoding", "user-agent"].includes(name)) headers[name] = value; });
    const child = spawn(executable, ["--fetch", roots], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr = (stderr + text).slice(-2000); });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(JSON.stringify({ method: request.method, url: request.url, headers, ...(body !== undefined ? { body } : {}), maxBytes: limit, timeoutMs: 0 }) + "\n");
    // The first line is the status and headers; everything after it is the body, passed on as it arrives.
    let pending = Buffer.alloc(0);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    const head = await new Promise<{ status?: number; headers?: Record<string, string>; error?: string }>((resolve, reject) => {
      const done = (value: { status?: number; headers?: Record<string, string>; error?: string }) => { if (!settled) { settled = true; resolve(value); } };
      child.stdout.on("data", (chunk: Buffer) => {
        if (!settled) {
          pending = Buffer.concat([pending, chunk]);
          const end = pending.indexOf(10);
          if (end < 0) { if (pending.length > 1024 * 1024) { child.kill(); done({ error: "Invalid response" }); } return; }
          let value: { status?: number; headers?: Record<string, string>; error?: string };
          try { value = JSON.parse(pending.subarray(0, end).toString("utf8")); } catch { value = { error: "Invalid response" }; }
          const rest = pending.subarray(end + 1); pending = rest;
          done(value);
          return;
        }
        if (!controller) { pending = Buffer.concat([pending, chunk]); return; }
        try { controller.enqueue(new Uint8Array(chunk)); } catch {}
      });
      child.once("error", reject);
      child.once("close", (code) => {
        signal?.removeEventListener("abort", abort);
        if (!settled) { done({ error: signal?.aborted ? "cancelled" : stderr.trim() || "No response" }); return; }
        if (!controller) { return; }
        try { if (code === 0) { controller.close(); } else { controller.error(new TypeError("terminated", { cause: new Error(signal?.aborted ? "cancelled" : stderr.trim() || "connection lost") })); } } catch {}
      });
    });
    if (signal?.aborted) { child.kill(); throw signal.reason; }
    if (head.error || !head.status) { child.kill(); throw new TypeError("fetch failed", { cause: new Error(head.error ?? "No response") }); }
    if (request.redirect === "error" && head.status >= 300 && head.status < 400) { child.kill(); throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); }
    const empty = request.method === "HEAD" || [101, 204, 205, 304].includes(head.status);
    const stream = empty ? null : new ReadableStream<Uint8Array>({
      start(c) { if (pending.length) { c.enqueue(new Uint8Array(pending)); pending = Buffer.alloc(0); } controller = c; if (child.exitCode !== null) { if (child.exitCode === 0) c.close(); else c.error(new TypeError("terminated")); } },
      cancel() { child.kill(); }
    });
    if (empty) { child.kill(); }
    const response = new Response(stream, { status: head.status, headers: head.headers ?? {} });
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
    const packaged = join(root, "app", "trusted-roots.pem");
    useHostNetwork(host.executable, await trustedRoots(existsSync(packaged) ? packaged : undefined));
    return true;
  } catch (error) { log(error); return false; }
}
