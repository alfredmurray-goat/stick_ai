import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {compactHistory} from '../src/agent/index.js';
import type {Message} from '../src/model/types.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
function rng(seed:number){return()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};}
const words=['fix','the','bug','in','parser.ts','é','🦈','  ','\n',' ',' ','tab\there','"quoted"','long'.repeat(40),'x'.repeat(120),'　'];
it.skipIf(!existsSync(host))('native compaction matches compactHistory on hundreds of generated conversations',()=>{
 const next=rng(7);const pick=<T,>(l:T[])=>l[Math.floor(next()*l.length)]!;
 const text=(n:number)=>Array.from({length:1+Math.floor(next()*n)},()=>pick(words)).join(pick([' ','','\n']));
 const cases:{messages:Message[];budget:number}[]=[];
 for(let n=0;n<400;n++){
  const messages:Message[]=[];const tasks=1+Math.floor(next()*8);
  if(next()<0.3)messages.push({role:'user',content:`<conversation_summary>Earlier in this conversation (summarised…):\n- The user asked: "${text(5)}"</conversation_summary>`},{role:'assistant',content:'<done>Noted.</done>'});
  for(let t=0;t<tasks;t++){
   messages.push({role:'user',content:text(30)+(next()<0.5?`\n\n<project_context>\n${text(10)}</project_context>`:'')});
   const steps=Math.floor(next()*4);
   for(let s=0;s<steps;s++){
    const target=pick([`"path":"${pick(['src/a.ts','b é.txt','🦈'.repeat(50)])}"`,`"query":"${text(3).replace(/[^a-z .]/gi,'')}"`,'"command":"npm test"','"path":null,"query":"q"','"path":5','"query":["a"]','']);
    const name=pick(['"read_file"','"search_files"','5','null','["a","b"]','{"x":1}']);
    messages.push({role:'assistant',content:`<think>${text(4)}</think><tool_call>${next()<0.9?`{"name":${name},"arguments":{${target}}}`:'not json'}</tool_call>`});
    messages.push({role:'user',content:`<tool_result>${text(40)}</tool_result>`});
   }
   messages.push({role:'assistant',content:next()<0.8?`<done>${text(20)}</done>`:`<done>${text(20)}`});
  }
  const size=messages.reduce((s,m)=>s+Buffer.byteLength(m.content),0);
  cases.push({messages,budget:Math.floor(size*pick([0.1,0.3,0.6,0.9,1.5]))});
 }
 const input=cases.map(c=>JSON.stringify(c)).join('\n')+'\n';
 const result=spawnSync(host,['--compact-check'],{input,encoding:'utf8',maxBuffer:512*1024*1024});
 expect(result.status,result.stderr).toBe(0);
 const lines=result.stdout.trim().split('\n');expect(lines).toHaveLength(cases.length);
 let summarised=0;
 cases.forEach((c,i)=>{const copy=c.messages.map(m=>({...m}));const compacted=compactHistory(copy,c.budget);const native=JSON.parse(lines[i]!);expect(native.compacted,`case ${i}`).toBe(compacted);expect(native.messages,`case ${i}`).toEqual(copy);if(compacted)summarised++;});
 expect(summarised).toBeGreaterThan(100);
 console.log('compaction parity: cases',cases.length,'summarised',summarised);
},60000);
