import {expect,it} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {AddressInfo} from 'node:net';
import {hostFetch} from '../src/portable/net.js';
import {McpRpc} from '../src/portable/mcp-rpc.js';
import {McpHttpTransport} from '../src/portable/mcp-http.js';
import {parseToolList,parseToolResult} from '../src/portable/mcp-results.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
const hasOpenssl=(()=>{try{execFileSync('openssl',['version']);return true;}catch{return false;}})();
it.skipIf(!existsSync(host)||!hasOpenssl)('a remote MCP server works through Host\'s HTTPS, with streamed replies',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stick-mcp-https-'));
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',join(dir,'k.pem'),'-out',join(dir,'c.pem')],{stdio:'ignore'});
  const seen:string[]=[];
  const server=createServer({key:readFileSync(join(dir,'k.pem')),cert:readFileSync(join(dir,'c.pem'))},(req,res)=>{
   if(req.method==='GET'){res.writeHead(405);res.end();return;}
   if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
   let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const m=JSON.parse(body);seen.push(`${m.method} ${req.headers.authorization} ${req.headers['mcp-session-id']??'-'}`);
    if(m.method==='initialize'){res.writeHead(200,{'Content-Type':'application/json','MCP-Session-Id':'s1'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'remote',version:'1'}}}));return;}
    if(!('id' in m)){res.writeHead(202);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:String(m.id),progress:1}})}\n\n`);
    const result=m.method==='tools/list'?{tools:[{name:'search',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'found é🦈 for '+m.params.arguments.q}]};
    setTimeout(()=>res.end(`data: ${JSON.stringify({jsonrpc:'2.0',id:m.id,result})}\n\n`),50);
   });
  });
  await new Promise<void>(d=>server.listen(0,'127.0.0.1',d));const port=(server.address() as AddressInfo).port;
  try{
   const notes:string[]=[];
   const rpc=new McpRpc(new McpHttpTransport(new URL(`https://localhost:${port}/mcp`),'http',new Headers({Authorization:'Bearer key'}),hostFetch(host,join(dir,'c.pem'))),m=>notes.push(m));
   const signal=new AbortController().signal;
   await rpc.connect(signal);
   expect(parseToolList(await rpc.request('tools/list',{},signal)).tools.map(t=>t.name)).toEqual(['search']);
   expect(parseToolResult(await rpc.request('tools/call',{name:'search',arguments:{q:'x'}},signal)).content[0]).toEqual({type:'text',text:'found é🦈 for x'});
   await rpc.close();
   expect(notes.filter(n=>n==='notifications/progress')).toHaveLength(2);
   expect(seen).toEqual(['initialize Bearer key -','notifications/initialized Bearer key s1','tools/list Bearer key s1','tools/call Bearer key s1']);
  }finally{server.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);
