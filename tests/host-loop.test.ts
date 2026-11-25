import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {runAgent} from '../src/agent/index.js';
import {runAgentOnHost} from '../src/agent/host-loop.js';
import type {Call,Message} from '../src/model/types.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
function rng(seed:number){return()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};}
const replies=[
 '<think>Look first.</think><tool_call>{"name":"read_file","arguments":{"path":"src/app.ts"}}</tool_call>',
 '<tool_call>{"name":"run_shell","arguments":{"command":"npm test"}}</tool_call>',
 '<tool_call>{"name":"search_files","arguments":{"query":"TODO é"}}</tool_call>',
 '<tool_call>{"name":"write_file","arguments":{"path":"a.ts","content":"hi 🦈"}}</tool_call>',
 '<tool_call>{"name":"delegate_code","arguments":{"task":"Add a function","context":"x"}}</tool_call>',
 'Just some text without tags.',
 '<done>Finished: fixed the parser 🦈</done>',
 '<tool_call>{"name":"edit_file","arguments":{"path":"a.ts","old":"x","new":"const f = (a) => a + 1"}}</tool_call>',
 '<tool_call>{"name":"edit_file","arguments":{"path":"a.ts","old":"x","new":"let y\u2028= 2 => 3"}}</tool_call>',
 '<tool_call>{"name":"edit_file","arguments":{"path":"a.ts","old":"x","new":"'+'line\\n'.repeat(25)+'"}}</tool_call>',
 '<tool_call>{"name":"edit_file","arguments":{"path":"a.ts","old":"x","new":"def\u00a0go(): pass"}}</tool_call>',
 '<tool_call>{"name":"edit_file","arguments":{"path":"a.ts","old":"x","new":"small fix"}}</tool_call>',
 '<tool_call>{"name":"delegate_code","arguments":{"task":"  ","context":"x"}}</tool_call>',
 '<tool_call>{"name":"delegate_code","arguments":{"task":"Add parser","context":"fail"}}</tool_call>',
 '<tool_call>{"name":"delegate_code","arguments":{"task":"Add parser","context":"empty"}}</tool_call>',
];
it.skipIf(!existsSync(host))('a task run through Stellan-Host matches runAgent, with hooks and tool errors',async()=>{
 const seen={required:0,code:0,failed:0};const next=rng(5);const pick=<T,>(l:T[])=>l[Math.floor(next()*l.length)]!;
 for(let i=0;i<120;i++){
  const prior:Message[]=[];for(let j=0;j<Math.floor(next()*3);j++)prior.push({role:'user',content:`Earlier ${j} `+'w '.repeat(Math.floor(next()*300))},{role:'assistant',content:'<done>ok</done>'});
  const script=Array.from({length:8},()=>pick(replies));const available=next()<0.6;const bytes=pick([8,32])*1024**3;const streamed=next()<0.5;const blockWrites=next()<0.5;const task=pick(['Fix it','Add a footer é']);const historyBytes=pick([300,1e9]);
  const run=async(onHost:boolean)=>{
   const events:unknown[]=[];let reply=0;const messages=prior.map(m=>({...m}));const prompts:Message[][]=[];
   const options={task,messages,maxSteps:2+Math.floor(i%7),historyBytes,taskInstructions:' Be brief. ',extraInstructions:'Extra.',signal:new AbortController().signal,
    model:{async complete(sent:Message[]){prompts.push(sent.map(m=>({...m})));const content=reply<script.length?script[reply++]!:'<done>end</done>';return {content,calls:[],summaryStreamed:streamed&&content.startsWith('<done>')};}} as never,
    tools:{async execute(call:Call){if(call.function.name==='run_shell')throw new Error('Command was not approved');return call.function.name==='edit_file'||call.function.name==='write_file'?`Wrote ${call.function.name}`:`${call.function.name}: ${call.function.arguments}`;}},
    hooks:{before:async(call:Call)=>blockWrites&&call.function.name==='write_file'?'no writes today':undefined,after:async(call:Call)=>call.function.name==='read_file'?'note from hook':''},
    specialist:{totalBytes:bytes,noSwap:false,available,code:async(task:string,context:string)=>{events.push(['code',task,context]);if(context==='fail')throw new Error('Max stopped');return context==='empty'?'  ':'```ts\ncode\n```';}},
    emit:(text:string,thinking:boolean)=>events.push(['emit',text,thinking]),log:(text:string)=>events.push(['log',text]),save:async(batch:Message[])=>{events.push(['save',batch]);},activity:(a:unknown)=>events.push(['activity',a])};
   const outcome=onHost?await runAgentOnHost(host,options):await runAgent(options);
   return {outcome,messages,events,prompts};
  };
  const onHost=await run(true);expect(onHost,`case ${i}`).toEqual(await run(false));
  const text=JSON.stringify(onHost);if(text.includes('Call delegate_code before'))seen.required++;if(text.includes('["code",'))seen.code++;if(text.includes('Code specialist failed'))seen.failed++;
 }
expect(seen.required).toBeGreaterThan(5);expect(seen.code).toBeGreaterThan(5);expect(seen.failed).toBeGreaterThan(2);console.log('delegation coverage',seen);
},120000);
