import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { webApp } from "../src/portable/web.js";
import { listenLocal } from "../src/portable/ports.js";
import type { ManagedEngine } from "../src/portable/engine.js";

it("feeds local uploads to the model, reports real token usage and resumes private chat notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stellan-input-memory-web-"));
  await cp(resolve("portable/ui"), join(root, "app/ui"), { recursive: true });
  const bodies: any[] = [];
  const inference = createServer(async (request, response) => {
    let body = ""; for await (const bytes of request) body += bytes; bodies.push(JSON.parse(body));
    response.writeHead(200, {"Content-Type":"text/event-stream"});
    response.end(`data: ${JSON.stringify({usage:{prompt_tokens:29,completion_tokens:8},choices:[{delta:{content:"Parser result: keep the strict validation."},finish_reason:"stop"}]})}\n\n`);
  });
  const port = await listenLocal(inference);
  const makeEngine = () => ({ active:null as string | null, baseUrl:`http://127.0.0.1:${port}`,key:"test",async start(model:string){this.active=model;},async stop(){this.active=null;} }) as unknown as ManagedEngine;
  const makeApp = () => webApp({root,engine:makeEngine(),bytes:32*1024**3,choices:["stellan-1-max"],noSwap:true,report:vi.fn(),log:vi.fn(),stop:async()=>{}});
  let app = await makeApp();
  const apiFor = () => {
    const url = new URL(app.url);
    return async (path:string, data?:unknown):Promise<any> => {
      const response = await fetch(url.origin + path, {method:data === undefined?"GET":"POST",headers:{Authorization:`Bearer ${url.hash.slice(1)}`,Origin:url.origin,...(data === undefined?{}:{"Content-Type":"application/json"})},...(data === undefined?{}:{body:JSON.stringify(data)})});
      expect(response.ok).toBe(true); return response.json();
    };
  };
  async function finished(api: ReturnType<typeof apiFor>) {
    for (let i=0;i<200;i++) { const state=await api("/api/state"); if(state.phase==="ready"&&state.events.some((e:any)=>e.kind==="task-complete"))return state; await new Promise(r=>setTimeout(r,10)); }
    throw Error("Task did not finish");
  }
  try {
    await app.start("stellan-1-max"); let api=apiFor();
    expect((await api("/api/state")).contextUsage.used).toBe(null);
    await api("/api/task",{text:"Review this parser",attachments:[{name:"parser.ts",data:Buffer.from("export const strict = true;").toString("base64")}]});
    const state=await finished(api);
    expect(state.contextUsage).toMatchObject({used:37,capacity:8192});
    expect(bodies[0].stream_options.include_usage).toBe(true);
    expect(bodies[0].messages.some((m:any)=>m.content.includes("export const strict = true;")&&m.content.includes("attached_files"))).toBe(true);
    const memory=await api("/api/chat-memory"); expect(memory.notes).toContain("strict validation");
    expect(await readFile(join(root,memory.file),"utf8")).toContain("Review this parser");
    expect((await fetch(new URL(app.url).origin+"/api/chat-memory")).status).toBe(403);
    await app.close(); app=await makeApp(); await app.start("stellan-1-max"); api=apiFor();
    await api("/api/task",{text:"What did we decide?"}); await finished(api);
    expect(bodies[1].messages.some((m:any)=>m.role==="user"&&m.content.includes("saved_chat_notes")&&m.content.includes("strict validation"))).toBe(true);
    expect(bodies[1].messages[0].content).not.toContain("saved_chat_notes");
    await api("/api/session/reset",{}); expect((await api("/api/chat-memory")).id).not.toBe(memory.id);
    expect(await readFile(join(root,memory.file),"utf8")).toContain("strict validation");
    await api("/api/long-context",{enabled:true});
    expect((await api("/api/state")).contextTokens.max).toBe(65536);
  } finally { await app.close(); inference.closeAllConnections(); await new Promise<void>(r=>inference.close(()=>r())); await rm(root,{recursive:true,force:true}); }
},20000);
