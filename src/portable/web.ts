import { createServer, type ServerResponse } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { projectContext } from "../agent/context.js";
import { friendlyError, type FriendlyError } from "./errors.js";
import { ProgressTracker } from "./progress.js";
import { coderSystem } from "../agent/delegate.js";
import { runAgent } from "../agent/index.js";
import { Ollama } from "../model/ollama.js";
import { Tools } from "../tools/index.js";
import { Sandbox } from "../sandbox/paths.js";
import { ramStatus } from "../config/models.js";
import type { Message } from "../model/types.js";
import { listenLocal } from "./ports.js";
import { userMessage, UserError } from "./platform.js";
import type { ManagedEngine } from "./engine.js";

export async function webApp(options: { root: string; engine: ManagedEngine; bytes: number; choices: string[]; noSwap: boolean; desktop?: boolean; faster?: boolean; report(text: string): void; log(error: unknown): void; stop(): Promise<void> }) {
  const { root, engine, report, log } = options;
  const token = randomBytes(32).toString("hex");
  const events: { id: number; kind: string; text?: string; data?: unknown }[] = [];
  let sequence = 0; let phase = "choose"; let failure = ""; let active: AbortController | undefined;
  let work: Promise<void> | undefined;
  let loading: AbortController | undefined;
  let problem: FriendlyError | undefined;
  let lastError: unknown;
  let faster = options.faster ?? false;
  const progress = new ProgressTracker();
  let progressView = progress.view();
  const fail = (error: unknown): void => {
    lastError = error; problem = friendlyError(error); failure = problem.message;
    publish("problem", undefined, problem);
  };
  engine.onOutput = (text, thinking) => { progress.output(); publish(thinking ? "thinking" : "coding", text); };
  engine.onModelStart = () => progress.begin("thinking");
  let origin = "";
  const history: Message[] = [];
  const approvals = new Map<string, (allow: boolean) => void>();
  const publish = (kind: string, text?: string, data?: unknown): void => {
    events.push({ id: ++sequence, kind, ...(text !== undefined ? { text } : {}), ...(data !== undefined ? { data } : {}) });
    if (events.length > 2000) { events.splice(0, events.length - 2000); }
  };
  await mkdir(join(root, "app", "project"), { recursive: true });
  const box = await Sandbox.create(join(root, "app", "project"));
  const tools = new Tools(box, (description, signal) => new Promise<boolean>((resolve) => {
    const id = randomUUID(); const space = description.indexOf(" "); const args = JSON.parse(description.slice(space + 1)) as Record<string, string>;
    const finish = (allow: boolean): void => { approvals.delete(id); signal.removeEventListener("abort", cancel); resolve(allow); };
    const cancel = (): void => finish(false);
    approvals.set(id, finish); signal.addEventListener("abort", cancel, { once: true });
    publish("approval", undefined, { id, file: basename(args.path ?? "your file"), before: args.old ?? "", after: args.new ?? args.content ?? "" });
  }));
  const launch = async (model: string): Promise<void> => {
    loading = new AbortController(); phase = "starting"; problem = undefined; failure = "";
    progress.begin("loading"); report("Starting your private assistant...");
    try { await engine.start(model as "stellan-1-lite" | "stellan-1-max", loading.signal); phase = "ready"; report("Running privately on this computer. Use Stop or quit the desktop app to stop."); }
    catch (error) { log(error); fail(error); phase = "error"; }
    finally { loading = undefined; }
  };
  const task = async (text: string): Promise<void> => {
    active = new AbortController(); phase = "working"; problem = undefined; failure = ""; progress.begin("reading");
    const selected = engine.active ?? "stellan-1-lite";
    try {
      if (selected === "stellan-1-max") {
        const result = await new Ollama(selected, engine.baseUrl, false, ramStatus(options.bytes), { apiKey: engine.key, specialist: true }).complete([{ role: "system", content: coderSystem }, { role: "user", content: text }], active.signal, (value, thinking) => { progress.output(); publish(thinking ? "thinking" : "answer", value); });
        if (!result.content) { throw new UserError("general"); } return;
      }
      await runAgent({
        task: text, messages: history, context: { source: projectContext(box), ...(faster ? { maxBytes: 4096 } : {}) },
        model: { complete: (...args) => { progress.begin("thinking"); return new Ollama(selected, engine.baseUrl, false, ramStatus(options.bytes), { apiKey: engine.key }).complete(...args); } },
        tools: { execute: (call, signal) => {
          if (call.function.name === "run_shell") { return Promise.resolve("Running programs is disabled in the private browser app. Make file changes instead."); }
          return tools.execute(call, signal);
        } },
        specialist: { totalBytes: options.bytes, noSwap: options.noSwap || faster, available: selected === "stellan-1-lite" && options.choices.includes("stellan-1-max"), code: (task, context, signal) => engine.code(task, context, signal, (message) => { publish("status", message); report(message); }) },
        maxSteps: 20, signal: active.signal,
        emit: (value, thinking) => { progress.output(); publish(thinking ? "thinking" : "answer", value); },
        log: (value) => { log(value); if (value.startsWith("Code specialist") || value === "Switching to the coding model...") { publish("status", value); } },
        save: async () => {}
      });
    } catch (error) { log(error); fail(error); }
    finally { active = undefined; phase = engine.active ? "ready" : "error"; report("Running privately on this computer. Use Stop or quit the desktop app to stop."); }
  };
  const send = (response: ServerResponse, code: number, data: unknown): void => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (request.headers.host !== origin.slice(7)) { send(response, 403, {}); return; }
      const url = new URL(request.url ?? "/", origin);
      const assets: Record<string, [string, string]> = { "/": ["index.html", "text/html"], "/main.js": ["main.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
      if (request.method === "GET" && assets[url.pathname]) {
        const asset = assets[url.pathname]!; response.writeHead(200, { "Content-Type": asset[1] }); response.end(await readFile(join(root, "app", "ui", asset[0]))); return;
      }
      if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin && request.headers.origin !== origin) { send(response, 403, {}); return; }
      if (request.method === "GET" && url.pathname === "/api/state") {
        const after = Number(url.searchParams.get("after") ?? 0);
        send(response, 200, { phase, failure, problem, desktop: options.desktop ?? false, progress: progressView, models: options.choices, paired: !options.noSwap && options.choices.includes("stellan-1-max"), events: events.filter((event) => event.id > after) }); return;
      }
      if (request.method !== "POST" || request.headers.origin !== origin || request.headers["content-type"] !== "application/json") { send(response, 403, {}); return; }
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 1000000) { throw new Error("UI body too large"); } }
      const data = JSON.parse(body) as Record<string, unknown>;
      if (url.pathname === "/api/start" && ["choose", "error"].includes(phase) && typeof data.model === "string" && options.choices.includes(data.model)) { work = launch(data.model); send(response, 202, {}); return; }
      if (url.pathname === "/api/task" && phase === "ready" && typeof data.text === "string" && data.text.trim()) { work = task(data.text.slice(0, 100000)); send(response, 202, {}); return; }
      if (url.pathname === "/api/approve" && typeof data.id === "string") { approvals.get(data.id)?.(data.allow === true); send(response, 200, {}); return; }
      if (url.pathname === "/api/cancel") { active?.abort(); loading?.abort(); send(response, 200, {}); return; }
      if (url.pathname === "/api/dismiss") { problem = undefined; failure = ""; send(response, 200, {}); return; }
      if (url.pathname === "/api/faster" && !active && !loading) {
        faster = true; engine.contextSize = 4096; problem = undefined; failure = "";
        work = (async () => { await engine.stop(); await launch("stellan-1-lite"); })();
        send(response, 202, {}); return;
      }
      if (url.pathname === "/api/stop") { send(response, 200, {}); void options.stop(); return; }
      send(response, 409, { error: "Please wait for this step to finish; then try again." });
    } catch (error) { log(error); if (!response.headersSent) { send(response, 400, { error: userMessage(new UserError("general")) }); } else { response.end(); } }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const port = await listenLocal(server); origin = `http://127.0.0.1:${port}`;
  let polling = false;
  const progressTimer = setInterval(() => {
    if (polling || !["working", "starting"].includes(phase)) { return; }
    polling = true;
    void Promise.resolve(engine.status?.()).then((status) => { progressView = progress.view(status); report(progressView.message); }).finally(() => { polling = false; });
  }, 500);
  return { async start() { await launch("stellan-1-lite"); if (phase !== "ready") { throw lastError; } }, url: `${origin}/#${token}`, async close() { clearInterval(progressTimer); active?.abort(); loading?.abort(); await work; for (const resolve of approvals.values()) { resolve(false); } server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
