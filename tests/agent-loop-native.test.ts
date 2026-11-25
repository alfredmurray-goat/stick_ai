import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {runAgent} from '../src/agent/index.js';
import {toolNames} from '../src/tools/schema.js';
import {maxRecommendedBytes} from '../src/config/models.js';
import type {Call,Message} from '../src/model/types.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
function rng(seed:number){return()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};}
const replies=[
 '<think>Look first.</think><tool_call>{"name":"read_file","arguments":{"path":"src/app.ts"}}</tool_call>',
 '<tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>',
 '<tool_call>{"name":"run_shell","arguments":{"command":"npm test"}}</tool_call>',
 '<tool_call>{"name":"search_files","arguments":{"query":"TODO é"}}</tool_call>',
 '<tool_call>{"name":"mcp_call","arguments":{"server":"github","tool":"list_issues","arguments":{}}}</tool_call>',
 '<tool_call>{"name":"mcp_tools","arguments":{"server":"actuent"}}</tool_call>',
 '<tool_call>{"name":"use_skill","arguments":{"name":"review"}}</tool_call>',
 '<tool_call>{"name":"delegate_code","arguments":{"task":"Add a function","context":"x"}}</tool_call>',
 '<tool_call>{"name":"write_file","arguments":{"path":"'+'🦈'.repeat(1500)+'","content":"hi"}}</tool_call>',
 'Just some text without tags.',
 '<tool_call>{"name":"invented","arguments":{}}</tool_call>',
 '<done>Finished: fixed the parser 🦈</done>',
 '<think>hm</think><done>All good.</done>',
 '<done>{"name":"read_file","arguments":{"path":"a"}}</done>',
];
it.skipIf(!existsSync(host))('the native agent loop matches runAgent step for step on scripted conversations',async()=>{
 const next=rng(11);const pick=<T,>(l:T[])=>l[Math.floor(next()*l.length)]!;
 const cases=Array.from({length:150},()=>{
  const messages:Message[]=[];const prior=Math.floor(next()*4);
  for(let i=0;i<prior;i++)messages.push({role:'user',content:`Earlier task ${i} `+'words '.repeat(Math.floor(next()*400))},{role:'assistant',content:`<done>answer ${i}</done>`});
  return {task:pick(['Fix the bug','Add a footer é','  Explain 🦈  ']),messages,maxSteps:1+Math.floor(next()*6),taskInstructions:pick(['','  Use the review skill.  ',' ']),historyBytes:pick([200,2000,1e9]),replies:Array.from({length:8},()=>pick(replies)),tools:toolNames,totalBytes:pick([8,16,32,64])*1024**3,recommendedBytes:maxRecommendedBytes,noSwap:next()<0.3};
 });
 const result=spawnSync(host,['--loop-check'],{input:cases.map(c=>JSON.stringify(c)).join('\n')+'\n',encoding:'utf8',maxBuffer:512*1024*1024});
 expect(result.status,result.stderr).toBe(0);
 const lines=result.stdout.trim().split('\n');expect(lines).toHaveLength(cases.length);
 const outcomes:Record<string,number>={};
 for(const [i,c] of cases.entries()){
  const events:Record<string,unknown>[]=[];let reply=0;const messages=c.messages.map(m=>({...m}));
  const outcome=await runAgent({task:c.task,messages,maxSteps:c.maxSteps,taskInstructions:c.taskInstructions,historyBytes:c.historyBytes,signal:new AbortController().signal,
   model:{async complete(sent:Message[]){const rest=sent.slice(1);events.push({type:'prompt',count:rest.length,last:rest.at(-1)!.content});return {content:reply<c.replies.length?c.replies[reply++]!:'<done>out of script</done>',calls:[]};}} as never,
   tools:{async execute(call:Call){const name=call.function.name,args=call.function.arguments;if(name==='run_shell')throw new Error('Tool failed: '+args);if(name==='search_files')return 'r'.repeat(40000)+'🦈';return `${name} ran with ${args}`;}},
   emit:(text,thinking)=>events.push({type:'emit',text,thinking}),log:text=>events.push({type:'log',text}),save:async batch=>{events.push({type:'save',batch:batch.map(m=>({role:m.role,content:m.content}))});},
   activity:a=>events.push({type:'activity',...a}),specialist:{totalBytes:c.totalBytes,noSwap:c.noSwap,available:false,code:async()=>''}});
  const native=JSON.parse(lines[i]!);
  expect(native.outcome,`case ${i}`).toBe(outcome);
  expect(native.messages,`case ${i}`).toEqual(messages.map(m=>({role:m.role,content:m.content})));
  expect(native.events,`case ${i}`).toEqual(events);
  outcomes[outcome]=(outcomes[outcome]??0)+1;
 }
 expect(outcomes.finished).toBeGreaterThan(20);expect(outcomes.limit).toBeGreaterThan(20);
 console.log('agent loop parity',outcomes);
},120000);
