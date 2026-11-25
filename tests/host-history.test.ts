import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {boundedToolHistory} from '../src/agent/context.js';
import type {Message} from '../src/model/types.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
function rng(seed:number){return()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};}
it.skipIf(!existsSync(host))('native boundedToolHistory matches the TypeScript one',()=>{
 const next=rng(3);const pieces=['a','é','🦈','\n','<tool_result>','word ','\n\n<project_context>\n'];
 const text=(n:number)=>Array.from({length:n},()=>pieces[Math.floor(next()*pieces.length)]).join('');
 const cases=Array.from({length:300},()=>{
  const messages:Message[]=[{role:'system',content:text(20)}];
  for(let i=0;i<1+Math.floor(next()*8);i++){const role=next()<0.5?'user':'assistant';messages.push({role,content:(role==='user'&&next()<0.5?'<tool_result>':'')+text(Math.floor(next()*200))});}
  return {messages,limit:Math.floor(next()*1500)};
 });
 const result=spawnSync(host,['--history-check'],{input:cases.map(c=>JSON.stringify(c)).join('\n')+'\n',encoding:'utf8',maxBuffer:64*1024*1024});
 expect(result.status,result.stderr).toBe(0);
 const lines=result.stdout.trim().split('\n');
 for(const [i,c] of cases.entries())expect(JSON.parse(lines[i]!),`case ${i}`).toEqual(boundedToolHistory(c.messages,c.limit).map(m=>({role:m.role,content:m.content})));
});
