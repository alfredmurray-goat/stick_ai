import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {parseMcpMessage} from '../src/portable/mcp-wire.js';
import {parseMcpInitialization} from '../src/portable/mcp-handshake.js';
import {parseToolList,parseToolResult} from '../src/portable/mcp-results.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
function rng(seed:number){return()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};}
it.skipIf(!existsSync(host))('Host checks MCP messages exactly like Stellan-Link',()=>{
 const next=rng(9);const pick=<T,>(l:T[])=>l[Math.floor(next()*l.length)]!;
 const scalar=()=>pick<unknown>([null,true,false,0,-1,1.5,2**53,2**53-1,'','x','é🦈','2.0','object','user','assistant','optional','text',['optional'],[],{}]);
 const maybe=(o:Record<string,unknown>,k:string,v:()=>unknown)=>{if(next()<0.7)o[k]=v();};
 const deep=(d:number):unknown=>d<=0?scalar():next()<0.5?[deep(d-1)]:{a:deep(d-1)};
 const tool=()=>{const t:Record<string,unknown>={};maybe(t,'name',()=>pick(['run','',3]));maybe(t,'inputSchema',()=>pick<unknown>([{type:'object'},{type:'object',properties:{a:{}},required:['a']},{type:'object',required:[1]},{type:'string'},null]));
  if(next()<0.3)t.annotations=pick<unknown>([{readOnlyHint:true},{readOnlyHint:'yes'},{title:3},[]]);if(next()<0.3)t.execution=pick<unknown>([{taskSupport:'optional'},{taskSupport:['required']},{taskSupport:'never'},{},null]);if(next()<0.2)t.outputSchema=pick<unknown>([{type:'object'},{}]);if(next()<0.2)t.description=scalar();return t;};
 const content=()=>{const c:Record<string,unknown>={type:pick(['text','image','audio','resource_link','resource','video',5])};maybe(c,'text',scalar);maybe(c,'data',()=>pick(['AA',1]));maybe(c,'mimeType',()=>pick(['image/png',null]));maybe(c,'uri',()=>pick(['file:///a',1]));maybe(c,'name',()=>pick(['a',1]));
  if(next()<0.4)c.resource=pick<unknown>([{uri:'u',text:'t'},{uri:'u',blob:'b'},{uri:'u'},{uri:1,text:'t'}]);if(next()<0.3)c.annotations=pick<unknown>([{audience:['user']},{audience:['bot']},{priority:0.5},{priority:2},{lastModified:1}]);return c;};
 const cases:{kind:string;value:unknown}[]=[];
 for(let i=0;i<4000;i++){
  const kind=pick(['message','init','tools','result']);let value:unknown;
  if(kind==='message'){const m:Record<string,unknown>={};maybe(m,'jsonrpc',()=>pick(['2.0','1.0',2]));const shape=pick(['method','result','error','none']);
   if(shape==='method'){maybe(m,'method',()=>pick(['tools/call',1]));maybe(m,'id',scalar);maybe(m,'params',()=>pick<unknown>([{},{_meta:{progressToken:pick<unknown>([1,'t',1.5,null])}},{_meta:{'io.modelcontextprotocol/related-task':pick<unknown>([{taskId:'a'},{taskId:1},null])}},[],null]));}
   if(shape==='result'){maybe(m,'id',scalar);maybe(m,'result',()=>pick<unknown>([{},{_meta:[]},{x:deep(70)},{x:deep(10)},'r']));}
   if(shape==='error'){maybe(m,'id',scalar);maybe(m,'error',()=>pick<unknown>([{code:-32600,message:'m'},{code:1.5,message:'m'},{code:1},{code:2**53,message:'m'}]));}
   if(next()<0.1)m.extra=1;value=m;}
  else if(kind==='init'){const v:Record<string,unknown>={};maybe(v,'protocolVersion',()=>pick(['2025-11-25',1]));maybe(v,'capabilities',()=>pick<unknown>([{},{tools:{}},{tools:{listChanged:true}},{tools:{listChanged:'y'}},{tools:[]},null]));maybe(v,'serverInfo',()=>pick<unknown>([{name:'s',version:'1'},{name:'s',version:'1',title:2},{name:'s'},{name:'s',version:'1',description:'d',websiteUrl:'w'}]));if(next()<0.2)v.instructions=scalar();value=v;}
  else if(kind==='tools'){const v:Record<string,unknown>={};maybe(v,'tools',()=>next()<0.8?Array.from({length:Math.floor(next()*4)},tool):'x');if(next()<0.3)v.nextCursor=pick<unknown>(['c',1]);value=v;}
  else {const v:Record<string,unknown>={};if(next()<0.8)v.content=next()<0.9?Array.from({length:Math.floor(next()*4)},content):'x';if(next()<0.3)v.isError=pick<unknown>([true,'no']);if(next()<0.3)v.structuredContent=pick<unknown>([{a:1},[1]]);value=v;}
  cases.push({kind,value});
 }
 cases.push({kind:'message',value:{jsonrpc:'2.0',id:1,result:{big:'x'.repeat(4*1024**2)}}},{kind:'message',value:{jsonrpc:'2.0',id:1,result:{big:'x'.repeat(4*1024**2-40)}}});
 const run=spawnSync(host,['--mcp-check'],{input:cases.map(c=>JSON.stringify(c)).join('\n')+'\n',encoding:'utf8',maxBuffer:256*1024**2});
 expect(run.status,run.stderr).toBe(0);
 const lines=run.stdout.trim().split('\n');expect(lines).toHaveLength(cases.length);
 let accepted=0;
 for(const [i,c] of cases.entries()){
  let expected:{ok:boolean;value?:unknown};
  try{const v=JSON.parse(JSON.stringify(c.value));expected={ok:true,value:c.kind==='message'?(parseMcpMessage(v),v):c.kind==='init'?parseMcpInitialization(v):c.kind==='tools'?parseToolList(v):parseToolResult(v)};}catch{expected={ok:false};}
  const native=JSON.parse(lines[i]!);
  expect(native.ok,`case ${i} ${JSON.stringify(c).slice(0,300)}`).toBe(expected.ok);
  if(expected.ok){accepted++;expect(native.value,`case ${i}`).toEqual(JSON.parse(JSON.stringify(expected.value)));}
 }
 expect(accepted).toBeGreaterThan(300);expect(cases.length-accepted).toBeGreaterThan(300);console.log('mcp wire parity',{accepted,rejected:cases.length-accepted});
},60000);
