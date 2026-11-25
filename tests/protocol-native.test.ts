import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {parseStep,TaggedStream} from '../src/model/protocol.js';
import {toolNames} from '../src/tools/schema.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
// Deterministic pseudo-random inputs so a failure is reproducible.
function rng(seed:number){return()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};}
const pieces=['<think>','</think>','<tool_call>','</tool_call>','<done>','</done>','<thi','</tool_','<do','ne>','<','>','{','}','[',']',',',':','"','\\','\\"','\\u00e9','\\ud83d\\ude00','\\ud800','\\n','\n',' ','name','arguments','"name"','"arguments"','"read_file"','"run_shell"','"invented"','1','-0','0.1','1e21','1e-7','123456789012345678901','1.5e300','true','false','null','é','🦈','text ','{"name":"read_file","arguments":{"path":"a.txt"}}','{"name":"read_file","arguments":{"path":"x","n":[1,2.50,{"k":null}]}}','{"name":["a","b"],"arguments":{}}','{"name":5,"arguments":{}}','{"arguments":{},"name":"write_file","name":"read_file"}','{"name":"read_file","arguments":[1]}'];
it.skipIf(!existsSync(host))('the native protocol parser matches the TypeScript one on thousands of inputs',()=>{
 const next=rng(42),cases:{content:string;chunks:string[]}[]=[];
 for(let n=0;n<3000;n++){
  const noise=(max:number)=>{let t='';const k=Math.floor(next()*max);for(let i=0;i<k;i++)t+=pieces[Math.floor(next()*pieces.length)];return t;};
  const pick=<T,>(list:T[])=>list[Math.floor(next()*list.length)]!;
  const shape=n%3;let content='';
  if(shape===0)content=noise(12)||'x';
  else if(shape===1)content=`${noise(2)}<think>${noise(3)}</think><tool_call>${pick(['{"name":"read_file","arguments":{"path":"a.txt"}}','{"name":"run_shell","arguments":{"command":"npm test","n":1e21,"m":-0,"f":0.1,"s":"é🦈\\n\\u0001"}}','{"name":"write_file","arguments":{"path":"x","content":"line\\nline"}}','{"name":"invented","arguments":{}}','{"name":"read_file","arguments":[1]}',noise(4)])}</tool_call>${noise(2)}`;
  else content=`${noise(2)}<done>${pick(['All done.','Fixed the bug 🦈','{"name":"read_file","arguments":{"path":"a"}}','{"name":"read_file","arguments":{"path":"a"},"x":1}',noise(4)])}<think>${noise(2)}</think>more</done>${noise(2)}`;
  const chunks:string[]=[];let at=0;while(at<content.length){const size=1+Math.floor(next()*9);chunks.push(content.slice(at,at+size));at+=size;}
  cases.push({content,chunks});
 }
 const input=cases.map(c=>JSON.stringify({content:c.content,tools:toolNames,chunks:c.chunks})).join('\n')+'\n';
 const result=spawnSync(host,['--protocol-check'],{input,encoding:'utf8',maxBuffer:256*1024*1024});
 expect(result.status).toBe(0);
 const lines=result.stdout.trim().split('\n');expect(lines).toHaveLength(cases.length);
 let compared=0;const kinds:Record<string,number>={};
 cases.forEach((c,i)=>{
  const native=JSON.parse(lines[i]!);const ts=parseStep(c.content);
  let text='',thinking='';const stream=new TaggedStream((piece,think)=>{if(think)thinking+=piece;else text+=piece;});for(const chunk of c.chunks)stream.push(chunk);stream.finish();
  const expected={content:ts.content,kind:ts.step.kind,name:ts.step.kind==='call'?ts.step.call.function.name:'',arguments:ts.step.kind==='call'?ts.step.call.function.arguments:'',summary:ts.step.kind==='done'?ts.step.summary:'',error:ts.step.kind==='error'?ts.step.error:'',text,thinking};
  // JSON syntax error wording differs between engines; everything else must match exactly.
  if(expected.kind==='error'&&expected.error.startsWith('Invalid tool call:')&&!/Unknown tool name|must be a JSON object/.test(expected.error)){expect(native.error.startsWith('Invalid tool call:'),c.content).toBe(true);native.error=expected.error;}
  expect(native,JSON.stringify(c.content)).toEqual(expected);compared++;kinds[expected.kind]=(kinds[expected.kind]??0)+1;
 });
 expect(compared).toBe(3000);
 // The mix must exercise every outcome, not just errors.
 expect(kinds.call).toBeGreaterThan(20);expect(kinds.done).toBeGreaterThan(20);expect(kinds.error).toBeGreaterThan(20);
 console.log('protocol parity outcomes',kinds);
},60000);
