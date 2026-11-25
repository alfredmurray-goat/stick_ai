import {expect,it,vi} from 'vitest';
import {cp,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {connect} from 'node:net';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {webApp} from '../src/portable/web.js';
import {openFrontDoor} from '../src/portable/front-door.js';
import {targetFor} from '../src/portable/platform.js';
import {hashFile} from '../src/portable/integrity.js';
import type {ManagedEngine} from '../src/portable/engine.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
async function stick(tamper=false){
 const root=await mkdtemp(join(tmpdir(),'stick-front-')),target=targetFor(process.platform,process.arch);
 await cp(resolve('portable/ui'),join(root,'app/ui'),{recursive:true});await mkdir(join(root,'app/project'),{recursive:true});await mkdir(join(root,'bin',target),{recursive:true});
 const path=`bin/${target}/stellan-host${process.platform==='win32'?'.exe':''}`;await cp(host,join(root,path));const record=await hashFile(join(root,path));
 await writeFile(join(root,'manifest.json'),JSON.stringify({nativeHost:true,files:[{path,...record,sha256:tamper?'0'.repeat(64):record.sha256,executable:true}]}));
 return root;
}
it.skipIf(!existsSync(host))('Host answers the window and forwards API requests to the Node backend with the same checks',async()=>{
 const root=await stick();
 const app=await webApp({root,engine:{active:null,baseUrl:'http://127.0.0.1:1',key:'x',async start(){}} as unknown as ManagedEngine,bytes:8*1024**3,choices:['stellan-1-lite'],noSwap:false,report:vi.fn(),log:vi.fn(),stop:async()=>{}});
 const front=await openFrontDoor(root,app.url);
 try{
  expect(front).toBeDefined();const url=new URL(front!.url);expect(url.hostname).toBe('127.0.0.1');expect(url.hash).toBe(new URL(app.url).hash);expect(url.port).not.toBe(new URL(app.url).port);
  const origin=url.origin,headers={Authorization:'Bearer '+url.hash.slice(1),Origin:origin};
  let r=await fetch(origin+'/');expect(r.status).toBe(200);expect(await r.text()).toContain('Start chatting');expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  r=await fetch(origin+'/api/state');await r.text();expect(r.status).toBe(403);
  r=await fetch(origin+'/api/state',{headers});expect(r.status).toBe(200);expect(await r.json()).toHaveProperty('phase');
  r=await fetch(origin+'/api/state',{headers:{...headers,Origin:'http://evil.example'}});await r.text();expect(r.status).toBe(403);
  r=await fetch(origin+'/api/session/reset',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});await r.text();expect(r.status).toBe(200);
  const raw=await new Promise<string>(done=>{const socket=connect(Number(url.port),'127.0.0.1',()=>socket.end('GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n'));let data='';socket.on('data',c=>{data+=c;});socket.on('end',()=>done(data));});
  expect(raw.startsWith('HTTP/1.1 403')).toBe(true);
 }finally{front?.close();await app.close();await rm(root,{recursive:true,force:true});}
},30000);
it.skipIf(!existsSync(host))('refuses a Host that does not match the package, and returns nothing without Host',async()=>{
 const root=await stick(true);
 try{await expect(openFrontDoor(root,'http://127.0.0.1:5000/#'+'a'.repeat(64))).rejects.toThrow(/does not match/);}finally{await rm(root,{recursive:true,force:true});}
 const plain=await mkdtemp(join(tmpdir(),'stick-front-plain-'));
 try{expect(await openFrontDoor(plain,'http://127.0.0.1:5000/#x')).toBeUndefined();}finally{await rm(plain,{recursive:true,force:true});}
},30000);
