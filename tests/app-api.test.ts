import { afterEach, expect, it, vi } from "vitest";
import { request } from "node:http";
import { AppApi, appApiInstructions, newAppKey, type AppApiHost } from "../src/portable/app-api.js";

const key = newAppKey();
let api: AppApi | undefined;
afterEach(async () => { await api?.stop(); api = undefined; });

function host(overrides: Partial<AppApiHost> = {}): AppApiHost & { approvals: string[]; prompts: unknown[] } {
  const approvals: string[] = [], prompts: unknown[] = [];
  return { approvals, prompts, busy: () => undefined, approve: async (app) => { approvals.push(app); return true; }, complete: async (messages, maxTokens) => { prompts.push({ messages, maxTokens }); return " Ahoy, traveller! "; }, log: vi.fn(), ...overrides };
}
// Raw HTTP so the test controls Host and Origin exactly, as a browser or a hostile page would send them.
function call(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: any }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    const req = request({ host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/v1/chat/completions", headers: { Host: `127.0.0.1:${port}`, ...(body ? { "Content-Type": "application/json" } : {}), ...options.headers } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text ? JSON.parse(text) : undefined }); });
    });
    req.on("error", reject); if (body) { req.write(body); } req.end();
  });
}
const chat = { messages: [{ role: "system", content: "You are a shopkeeper." }, { role: "user", content: "Hello!" }], max_tokens: 5000 };

it("answers an approved local app in the OpenAI chat format, asking the user once per app", async () => {
  const fake = host(); api = new AppApi(fake, key, 0); await api.start();
  const headers = { Authorization: `Bearer ${key}`, "X-Stellan-App": "Dungeon Game", Origin: "http://localhost:5173" };
  const first = await call(api.port, { headers, body: chat });
  expect(first.status).toBe(200);
  expect(first.json.choices[0].message).toEqual({ role: "assistant", content: " Ahoy, traveller! " });
  expect(first.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  expect((fake.prompts[0] as { maxTokens: number }).maxTokens).toBe(1024);
  await call(api.port, { headers, body: chat });
  expect(fake.approvals).toEqual(["Dungeon Game"]);
  const models = await call(api.port, { method: "GET", path: "/v1/models", headers });
  expect(models.json.data[0].id).toBe("stellan");
});

it("refuses wrong keys, web pages from the internet, rebinding hosts and denied apps", async () => {
  let allow = false;
  const fake = host({ approve: async () => allow }); api = new AppApi(fake, key, 0); await api.start();
  expect((await call(api.port, { body: chat })).status).toBe(401);
  expect((await call(api.port, { headers: { Authorization: "Bearer stellan-app-wrong" }, body: chat })).status).toBe(401);
  const evil = await call(api.port, { headers: { Authorization: `Bearer ${key}`, Origin: "https://evil.example" }, body: chat });
  expect(evil.status).toBe(403); expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  const preflight = await call(api.port, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  expect(preflight.status).toBe(403);
  const rebinding = await call(api.port, { headers: { Authorization: `Bearer ${key}`, Host: "attacker.example" }, body: chat });
  expect(rebinding.status).toBe(403);
  const denied = await call(api.port, { headers: { Authorization: `Bearer ${key}`, "X-Stellan-App": "Spy" }, body: chat });
  expect(denied.status).toBe(403); expect(denied.json.error.message).toContain("didn't allow Spy");
  allow = true; // the answer is remembered until a new conversation
  expect((await call(api.port, { headers: { Authorization: `Bearer ${key}`, "X-Stellan-App": "Spy" }, body: chat })).status).toBe(403);
  api.forgetApps();
  expect((await call(api.port, { headers: { Authorization: `Bearer ${key}`, "X-Stellan-App": "Spy" }, body: chat })).status).toBe(200);
  const local = await call(api.port, { method: "OPTIONS", headers: { Origin: "null" } });
  expect(local.status).toBe(204); expect(local.headers["access-control-allow-headers"]).toContain("Authorization");
});

it("says when Stellan is busy instead of interrupting, and rejects malformed requests", async () => {
  let reason: string | undefined = "Stellan is busy with the user's own task. Try again in a moment.";
  const fake = host({ busy: () => reason }); const fakeApprovals = fake.approvals;
  api = new AppApi(fake, key, 0); await api.start();
  const auth = { Authorization: `Bearer ${key}` };
  const busy = await call(api.port, { headers: auth, body: chat });
  expect(busy.status).toBe(503); expect(busy.headers["retry-after"]).toBe("5");
  expect(fakeApprovals).toEqual([]); // nobody is asked about an app Stellan can't answer yet
  reason = undefined;
  expect((await call(api.port, { headers: auth, body: "not json" })).status).toBe(400);
  expect((await call(api.port, { headers: auth, body: { messages: [] } })).status).toBe(400);
  expect((await call(api.port, { headers: auth, body: { messages: [{ role: "tool", content: "x" }] } })).status).toBe(400);
  expect((await call(api.port, { headers: auth, body: { ...chat, stream: true } })).status).toBe(400);
  expect((await call(api.port, { headers: auth, body: { messages: [{ role: "user", content: "x".repeat(70000) }] } })).status).toBe(400);
  expect((await call(api.port, { headers: auth, path: "/v1/other", body: chat })).status).toBe(404);
});

it("only listens on this computer and explains a port that's already taken", async () => {
  api = new AppApi(host(), key, 0); await api.start();
  const second = new AppApi(host(), key, api.port);
  await expect(second.start()).rejects.toThrow();
  expect(second.problem).toContain(`Port ${api.port} is already used`);
  const text = appApiInstructions(api.port, key);
  expect(text).toContain(`http://127.0.0.1:${api.port}/v1/chat/completions`); expect(text).toContain(key);
  expect(newAppKey()).toMatch(/^stellan-app-[0-9a-f]{48}$/);
});
