import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// "Stellan for your apps": an opt-in, OpenAI-style chat endpoint on 127.0.0.1 so apps that Stellan builds
// (a game character, a helper inside a web page) can be powered by Stellan on the same computer. It is off
// by default, never listens beyond this computer, checks the Host header (no DNS rebinding) and Origin
// (only pages served from this computer), needs the stick's app key, and asks the user once per app.
export const defaultAppApiPort = 7341;
export const appApiLimits = { bodyBytes: 256 * 1024, messageChars: 64000, messages: 64, maxTokens: 1024, defaultTokens: 256, appName: 60 } as const;
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export interface AppApiHost {
  /** Why the model can't take a request right now (busy, resting, not started), or undefined. */
  busy(): string | undefined;
  complete(messages: ChatMessage[], maxTokens: number, signal: AbortSignal): Promise<string>;
  /** Shows the "Let this app use Stellan?" card. */
  approve(app: string, signal: AbortSignal): Promise<boolean>;
  log(error: unknown): void;
}
export const newAppKey = (): string => `stellan-app-${randomBytes(24).toString("hex")}`;
const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
function cleanAppName(value: string | undefined): string | undefined {
  const name = value?.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, appApiLimits.appName);
  return name || undefined;
}
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AppApi {
  private server: Server | undefined;
  private decisions = new Map<string, boolean>();
  private working = false;
  private life = new AbortController();
  port: number;
  problem = "";
  constructor(private host: AppApiHost, private key: string, port = defaultAppApiPort) { this.port = port; }
  get running(): boolean { return Boolean(this.server?.listening); }
  get busy(): boolean { return this.working; }
  setKey(key: string): void { this.key = key; this.decisions.clear(); }
  /** Forget per-app answers (a new conversation or a new key asks again). */
  forgetApps(): void { this.decisions.clear(); }
  async start(): Promise<void> {
    if (this.server) { return; }
    this.life = new AbortController(); this.problem = "";
    const server = createServer((request, response) => { void this.handle(request, response).catch((error) => { this.host.log(error); if (!response.headersSent) { this.send(response, 500, { error: { message: "Stellan couldn't answer. Try again." } }); } else { response.destroy(); } }); });
    server.requestTimeout = 600000; server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    }).catch((error: NodeJS.ErrnoException) => {
      this.problem = error.code === "EADDRINUSE" ? `Port ${this.port} is already used by another program, so apps can't reach Stellan. Close that program and turn this on again.` : "The app connection couldn't start. Turn it off and on again.";
      throw error;
    });
    const address = server.address();
    if (address && typeof address === "object") { this.port = address.port; }
    this.server = server;
  }
  async stop(): Promise<void> {
    this.life.abort();
    const server = this.server; this.server = undefined; this.decisions.clear();
    if (!server) { return; }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  private send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
    response.end(JSON.stringify(body));
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    const cors: Record<string, string> = origin && (origin === "null" || localOrigin.test(origin)) ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {};
    const fail = (status: number, message: string, extra: Record<string, string> = {}): void => this.send(response, status, { error: { message } }, { ...cors, ...extra });
    // A web page on the internet can't use this: only pages from this computer (or files opened directly).
    if (origin && !cors["Access-Control-Allow-Origin"]) { fail(403, "Only apps running on this computer can use Stellan."); return; }
    const hostHeader = request.headers.host ?? "";
    if (hostHeader !== `127.0.0.1:${this.port}` && hostHeader !== `localhost:${this.port}`) { fail(403, "Use http://127.0.0.1:" + this.port + " to reach Stellan."); return; }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Stellan-App", "Access-Control-Max-Age": "600" });
      response.end(); return;
    }
    const auth = request.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !same(auth.slice(7), this.key)) { fail(401, "Missing or wrong app key. Copy it from Stick AI: Settings, Models, Stellan for your apps."); return; }
    if (request.method === "GET" && url.pathname === "/v1/models") { this.send(response, 200, { object: "list", data: [{ id: "stellan", object: "model", owned_by: "stick-ai" }] }, cors); return; }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") { fail(404, "Stellan answers POST /v1/chat/completions."); return; }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > appApiLimits.bodyBytes) { fail(413, "The request is too large (256 KB at most)."); return; } chunks.push(chunk as Buffer); }
    let body: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { throw new Error(); } body = parsed as Record<string, unknown>; }
    catch { fail(400, "Send a JSON body like {\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}."); return; }
    if (body.stream === true) { fail(400, "Streaming isn't supported yet; leave stream off."); return; }
    const raw = body.messages;
    if (!Array.isArray(raw) || !raw.length || raw.length > appApiLimits.messages) { fail(400, "messages must be a list of 1 to 64 {role, content} items."); return; }
    const messages: ChatMessage[] = []; let chars = 0;
    for (const item of raw) {
      const message = item as Record<string, unknown>;
      if (!message || typeof message !== "object" || !["system", "user", "assistant"].includes(message.role as string) || typeof message.content !== "string") { fail(400, "Each message needs a role (system, user or assistant) and text content."); return; }
      chars += message.content.length;
      messages.push({ role: message.role as ChatMessage["role"], content: message.content });
    }
    if (chars > appApiLimits.messageChars) { fail(400, "The messages are too long (64,000 characters at most)."); return; }
    const requested = typeof body.max_tokens === "number" && Number.isInteger(body.max_tokens) ? body.max_tokens : appApiLimits.defaultTokens;
    const maxTokens = Math.max(1, Math.min(appApiLimits.maxTokens, requested));
    const app = cleanAppName(request.headers["x-stellan-app"] as string | undefined) ?? (origin && origin !== "null" ? origin : "An app on this computer");
    // Say "busy" or "resting" straight away rather than asking the user about an app that can't be answered yet.
    const early = this.host.busy();
    if (early) { fail(503, early, { "Retry-After": "5" }); return; }
    let allowed = this.decisions.get(app);
    if (allowed === undefined) {
      if (this.working) { fail(503, "Stellan is busy with another app. Try again in a moment.", { "Retry-After": "5" }); return; }
      this.working = true;
      try { allowed = await this.host.approve(app, this.life.signal); } finally { this.working = false; }
      this.decisions.set(app, allowed);
    }
    if (!allowed) { fail(403, `You didn't allow ${app} to use Stellan. Start a new conversation in Stick AI to be asked again.`); return; }
    const reason = this.host.busy();
    if (reason || this.working) { fail(503, reason ?? "Stellan is busy with another app. Try again in a moment.", { "Retry-After": "5" }); return; }
    this.working = true;
    const abort = new AbortController(); const cancel = (): void => abort.abort();
    response.once("close", () => { if (!response.writableEnded) { cancel(); } }); this.life.signal.addEventListener("abort", cancel, { once: true });
    try {
      const content = await this.host.complete(messages, maxTokens, abort.signal);
      this.send(response, 200, { id: `stellan-${randomBytes(8).toString("hex")}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "stellan", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }, cors);
    } finally { this.working = false; this.life.signal.removeEventListener("abort", cancel); }
  }
}

/** What Stellan is told when the user asks for an app that uses AI (sent with the task, never the system message). */
export function appApiInstructions(port: number, key: string): string {
  return `<stellan_app_api>\nApps on this computer can use Stellan (you) as their AI, offline. Use it when the user wants an app with AI inside it, such as game characters that talk, a chat helper or text generation.\nEndpoint: POST http://127.0.0.1:${port}/v1/chat/completions with headers Content-Type: application/json, Authorization: Bearer ${key} and X-Stellan-App: <a short app name>. Body: {"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."}],"max_tokens":200}. The reply text is choices[0].message.content. Non-streaming only; max_tokens is capped at 1024.\nThe first request from each app asks the user to allow it. Handle 503 (Stellan busy: show "thinking…" and retry after a few seconds), 403 (not allowed) and 401 (wrong key) with a friendly message in the app. Pages must be served from this computer (http://localhost or http://127.0.0.1) or opened as a local file. Keep the key in one config file (for example stellan.config.js) and mention it in the summary; the user can make a new key in Settings.\n</stellan_app_api>`;
}
