import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {AddressInfo} from 'node:net';
import {hostFetch} from '../src/portable/net.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
const hasOpenssl=(()=>{try{execFileSync('openssl',['version']);return true;}catch{return false;}})();
it.skipIf(!existsSync(host)||!hasOpenssl)('Host HTTPS checks certificates and host names and reads chunked bodies',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stick-tls-'));
 try{
  const make=(name:string,cn:string)=>execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj',`/CN=${cn}`,'-addext',`subjectAltName=DNS:${cn}`,'-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.pem')],{stdio:'ignore'});
  make('good','localhost');make('other','localhost');
  const {readFileSync}=await import('node:fs');
  let released!:()=>void;const gate=new Promise<void>(r=>released=r);
  const server=createServer({key:readFileSync(join(dir,'good.key')),cert:readFileSync(join(dir,'good.pem'))},(request,response)=>{
   if(request.url==='/redirect'){response.writeHead(302,{Location:'/elsewhere'});response.end();return;}
   if(request.url==='/big'){response.writeHead(200);const chunk=Buffer.alloc(1024*1024,97);for(let i=0;i<20;i++)response.write(chunk);response.end();return;}
   if(request.url==='/events'){response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: one\n\n');gate.then(()=>{response.end('data: two\n\n');});return;}
   if(request.url==='/slow'){setTimeout(()=>response.end('late'),5000);return;}
   let body='';request.on('data',c=>body+=c);request.on('end',()=>{response.writeHead(201,{'X-Seen':request.headers.authorization??''});response.write('{"got":');response.end(JSON.stringify(body)+',"é":"🦈"}');});
  });
  await new Promise<void>(d=>server.listen(0,'127.0.0.1',d));const port=(server.address() as AddressInfo).port;
  try{
   const f=hostFetch(host,join(dir,'good.pem'));
   const json=await f(`https://localhost:${port}/j`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer t'},body:'{"a":1}'});
   expect(json.status).toBe(201);expect(json.headers.get('x-seen')).toBe('Bearer t');expect(await json.json()).toEqual({got:'{"a":1}','é':'🦈'});
   const moved=await f(`https://localhost:${port}/redirect`,{redirect:'manual'});expect(moved.status).toBe(302);expect(moved.headers.get('location')).toBe('/elsewhere');await moved.body?.cancel();
   await expect(f(`https://localhost:${port}/redirect`,{redirect:'error'})).rejects.toThrow(/fetch failed/);
   const big=await f(`https://localhost:${port}/big`,{redirect:'manual'});expect(Buffer.from(await big.arrayBuffer()).length).toBe(20*1024*1024);
   const aborted=new AbortController();const pending=f(`https://localhost:${port}/slow`,{signal:aborted.signal});setTimeout(()=>aborted.abort(),200);await expect(pending).rejects.toThrow();
   const ok=await f(`https://localhost:${port}/x`,{method:'POST',headers:{Authorization:'Bearer t'},body:'hello'});
   expect(ok.status).toBe(201);expect(await ok.json()).toEqual({got:'hello','é':'🦈'});
   await expect(f(`https://127.0.0.1:${port}/x`)).rejects.toThrow(/fetch failed/);
   await expect(f(`http://localhost:${port}/x`)).rejects.toThrow(/fetch failed/);
   await expect(hostFetch(host,join(dir,'other.pem'))(`https://localhost:${port}/x`)).rejects.toThrow(/fetch failed/);
   // Event streams arrive while the server is still sending (the second event only after the first is read).
   const events=await f(`https://localhost:${port}/events`);expect(events.headers.get('content-type')).toBe('text/event-stream');
   const reader=events.body!.getReader();const first=new TextDecoder().decode((await reader.read()).value);expect(first).toContain('data: one');
   released();let rest='';for(;;){const p=await reader.read();if(p.done)break;rest+=new TextDecoder().decode(p.value);}expect(rest).toContain('data: two');
  }finally{server.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);
