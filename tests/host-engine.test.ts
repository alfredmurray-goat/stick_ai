import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import type {AddressInfo} from 'node:net';
import {runAgent} from '../src/agent/index.js';
import {runAgentOnHost} from '../src/agent/host-loop.js';
import {Ollama} from '../src/model/ollama.js';
import type {Call,Message} from '../src/model/types.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
const replies=[
 '<think>Look first é.</think><tool_call>{"name":"read_file","arguments":{"path":"src/app.ts"}}</tool_call>',
 '<tool_call>{"name":"run_shell","arguments":{"command":"npm test"}}</tool_call>',
 '<tool_call>{"name":"search_files","arguments":{"query":"TODO"}}</tool_call>',
 'No tags here 🦈',
 '<done>Finished: fixed the parser 🦈</done>',
];
it.skipIf(!existsSync(host))('Host calls Stellan-Run itself with the same requests and the same results as the app',async()=>{
 let script:string[]=[];const bodies:unknown[]=[];
 const server=createServer((request,response)=>{
  let body='';request.on('data',c=>body+=c);request.on('end',()=>{
   expect(request.headers.authorization).toBe('Bearer test-key');expect(request.url).toBe('/v1/chat/completions');
   bodies.push(JSON.parse(body));const reply=script.shift()??'<done>end</done>';
   response.writeHead(200,{'Content-Type':'text/event-stream'});
   const events=[`data: ${JSON.stringify({choices:[{delta:{reasoning_content:'hmm'}}]})}\n\n`];
   for(let i=0;i<reply.length;i+=7)events.push(`data: ${JSON.stringify({choices:[{delta:{content:reply.slice(i,i+7)}}]})}\n\n`);
   events.push(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`);
   const all=events.join('');let at=0;const next=()=>{if(at>=all.length){response.end();return;}const n=1+((at*31)%40);response.write(all.slice(at,at+n));at+=n;setImmediate(next);};next();
  });
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as AddressInfo).port;
 try{
  for(let i=0;i<12;i++){
   const historyBytes=i%2?400:1e9;
   const run=async(onHost:boolean)=>{
    script=[...replies.slice(i%3),...replies].slice(0,5);bodies.length=0;
    const events:unknown[]=[];const usage:number[]=[];const messages:Message[]=[{role:'user',content:'Earlier task '+'w '.repeat(300)},{role:'assistant',content:'<done>ok</done>'}];
    const model=new Ollama('stellan-1-lite',`http://127.0.0.1:${port}`,false,undefined,{apiKey:'test-key',historyBytes,onUsage:t=>usage.push(t)});
    const options={task:'Fix it é',messages,maxSteps:4,historyBytes:1e9,taskInstructions:'Be brief.',signal:new AbortController().signal,model,
     tools:{async execute(call:Call){if(call.function.name==='run_shell')throw new Error('Command was not approved');return `${call.function.name}: `+'x'.repeat(300);}},
     specialist:{totalBytes:8*1024**3,noSwap:false,available:false,code:async()=>''},
     emit:(text:string,thinking:boolean)=>events.push(['emit',text,thinking]),log:(text:string)=>events.push(['log',text]),save:async(batch:Message[])=>{events.push(['save',batch]);},activity:(a:unknown)=>events.push(['activity',a])};
    const outcome=onHost?await runAgentOnHost(host,{...options,engine:{port,key:'test-key',options:model.requestOptions(),historyBytes,onUsage:t=>usage.push(t)}}):await runAgent(options);
    // Streaming splits text differently; compare what the user sees, joined.
    const joined:unknown[]=[];for(const e of events){const last=joined.at(-1) as unknown[]|undefined;if(Array.isArray(e)&&e[0]==='emit'&&last?.[0]==='emit'&&last[2]===e[2]){last[1]+=e[1] as string;}else joined.push(Array.isArray(e)?[...e]:e);}
    return {outcome,messages,events:joined,usage,bodies:[...bodies]};
   };
   const a=await run(true),b=await run(false);
   expect(a,`case ${i}`).toEqual(b);
  }
 }finally{server.close();}
},120000);
