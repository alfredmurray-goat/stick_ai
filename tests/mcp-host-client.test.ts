import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {HostMcpRpc} from '../src/portable/mcp-host-rpc.js';
import {McpRpc} from '../src/portable/mcp-rpc.js';
import {McpProcessTransport} from '../src/portable/mcp-process.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
// A small MCP server: answers initialize, lists two tools, echoes calls, pings the client, sends progress, and can
// fail a call or send a broken line on request.
const server=`
const rl=require('readline').createInterface({input:process.stdin});let pinged=false;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fake',version:'1'}}});
 if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',inputSchema:{type:'object'}},{name:'fail',inputSchema:{type:'object'}}]}});
 if(m.method==='tools/call'){const a=m.params.arguments;
  if(!pinged){pinged=true;send({jsonrpc:'2.0',id:'p1',method:'ping'});}
  send({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:m.params._meta.progressToken,progress:1,message:'working é'}});
  if(m.params.name==='fail')return send({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'no'}});
  if(a.broken){process.stdout.write('{not json}\\n');return;}
  if(a.slow)return;
  return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'echo '+JSON.stringify(a)+' token '+m.params._meta.progressToken}]}});}
 if(m.id==='p1'||m.method==='notifications/initialized')return;
});`;
it.skipIf(!existsSync(host)||process.platform==='win32')("Link in Host behaves like the app's MCP client",async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stick-mcp-'));const script=join(dir,'server.cjs');await writeFile(script,server);
 try{
  const run=async(onHost:boolean)=>{
   const events:unknown[]=[];const notify=(method:string,params:Record<string,unknown>)=>events.push(['note',method,params]);
   const rpc=onHost?new HostMcpRpc(host,['--mcp-client',dir,'--',process.execPath,script],{...process.env} as Record<string,string>,()=>{},notify)
    :new McpRpc(new McpProcessTransport(process.execPath,[script],{...process.env} as Record<string,string>,()=>{}),notify);
   const signal=new AbortController().signal;
   await rpc.connect(signal);events.push(['ready',rpc.ready]);
   events.push(['list',await rpc.request('tools/list',{},signal)]);
   events.push(['call',await rpc.request('tools/call',{name:'echo',arguments:{x:'é🦈'}},signal)]);
   await rpc.request('tools/call',{name:'fail',arguments:{}},signal).then(v=>events.push(['ok?',v]),e=>events.push(['err',String(e.message)]));
   const slow=new AbortController();const pending=rpc.request('tools/call',{name:'echo',arguments:{slow:true}},slow.signal);setTimeout(()=>slow.abort(new Error('stopped')),100);
   await pending.then(v=>events.push(['ok?',v]),e=>events.push(['cancelled',String(e.message)]));
   await new Promise(r=>setTimeout(r,300));events.push(['closed after cancel',rpc.closed]);
   await rpc.request('tools/list',{},signal).then(v=>events.push(['ok?',v]),e=>events.push(['err',String(e.message)]));
   await rpc.close();
   return events;
  };
  const native=await run(true),node=await run(false);
  expect(native).toEqual(node);
  // A broken line from the server closes the connection in both.
  const broken=async(onHost:boolean)=>{const rpc=onHost?new HostMcpRpc(host,['--mcp-client',dir,'--',process.execPath,script],{...process.env} as Record<string,string>,()=>{}):new McpRpc(new McpProcessTransport(process.execPath,[script],{...process.env} as Record<string,string>,()=>{}));const s=new AbortController().signal;await rpc.connect(s);
   const r=await rpc.request('tools/call',{name:'echo',arguments:{broken:true}},s).then(()=>'ok',e=>String(e.message));await new Promise(r=>setTimeout(r,200));const closed=rpc.closed;await rpc.close();return [r,closed];};
  expect(await broken(true)).toEqual(await broken(false));
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);
