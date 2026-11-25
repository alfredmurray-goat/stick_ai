import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {AddressInfo} from 'node:net';
import {hostFetch} from '../src/portable/net.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
const hasOpenssl=(()=>{try{execFileSync('openssl',['version']);return true;}catch{return false;}})();
function fetchAll(ca:string,requests:unknown[]){
 return new Promise<Record<string,unknown>[]>((done,fail)=>{
  const child=spawn(host,['--fetch',ca]);let out='';child.stdout.on('data',d=>out+=d);child.on('error',fail);
  child.on('close',()=>done(out.trim().split('\n').map(l=>JSON.parse(l))));
  child.stdin.end(requests.map(r=>JSON.stringify(r)).join('\n')+'\n');
 });
}
it.skipIf(!existsSync(host)||!hasOpenssl)('Host HTTPS checks certificates and host names and reads chunked bodies',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stick-tls-'));
 try{
  const make=(name:string,cn:string)=>execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj',`/CN=${cn}`,'-addext',`subjectAltName=DNS:${cn}`,'-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.pem')],{stdio:'ignore'});
  make('good','localhost');make('other','localhost');
  const {readFileSync}=await import('node:fs');
  const server=createServer({key:readFileSync(join(dir,'good.key')),cert:readFileSync(join(dir,'good.pem'))},(request,response)=>{
   if(request.url==='/redirect'){response.writeHead(302,{Location:'/elsewhere'});response.end();return;}
   if(request.url==='/big'){response.writeHead(200);const chunk=Buffer.alloc(1024*1024,97);for(let i=0;i<20;i++)response.write(chunk);response.end();return;}
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
   const [ok,wrongName,plain]=await fetchAll(join(dir,'good.pem'),[
    {method:'POST',url:`https://localhost:${port}/x`,headers:{Authorization:'Bearer t'},body:'hello',saveTo:join(dir,'a')},
    {method:'GET',url:`https://127.0.0.1:${port}/x`,saveTo:join(dir,'b')},
    {method:'GET',url:`http://localhost:${port}/x`,saveTo:join(dir,'c')}]);
   expect(ok!.status).toBe(201);expect((ok!.headers as Record<string,string>)['x-seen']).toBe('Bearer t');expect(JSON.parse(readFileSync(join(dir,'a'),'utf8'))).toEqual({got:'hello','é':'🦈'});
   
   expect(wrongName!.error).toMatch(/could not be verified|failed/);
   expect(plain!.error).toMatch(/Only https/);
   const [untrusted]=await fetchAll(join(dir,'other.pem'),[{method:'GET',url:`https://localhost:${port}/x`,saveTo:join(dir,'u')}]);
   expect(untrusted!.error).toMatch(/could not be verified/);
  }finally{server.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);
