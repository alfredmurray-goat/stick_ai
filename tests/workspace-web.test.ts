import {afterEach,expect,it,vi} from 'vitest';
import {request} from 'node:http';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {webApp} from '../src/portable/web.js';
import {Ollama} from '../src/model/ollama.js';
import type {ManagedEngine} from '../src/portable/engine.js';
afterEach(()=>vi.restoreAllMocks());
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'stick-workspace-test-'));await cp(resolve('portable/ui'),join(root,'app/ui'),{recursive:true});
 const engine={active:null as string|null,baseUrl:"http://127.0.0.1:8080",key:"fixture",async start(model:string){this.active=model;}};
 const app=await webApp({root,engine:engine as unknown as ManagedEngine,bytes:8*1024**3,choices:['stellan-1-lite'],noSwap:false,report:vi.fn(),log:vi.fn(),stop:async()=>{}});const url=new URL(app.url);
 const headers={Authorization:'Bearer '+url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json'};
 const api=async(path:string,body?:object)=>{const response=await fetch(url.origin+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
 return {root,app,url,headers,api,close:async()=>{await app.close();await rm(root,{recursive:true,force:true});}};
}
it('browses only project files, rejects traversal, and safely saves UTF-8 split across network chunks',async()=>{
 const f=await fixture();try {
  const project=join(f.root,'app/project');await writeFile(join(project,'README.md'),'original');await mkdir(join(project,'.git'));await mkdir(join(project,'src'));await writeFile(join(f.root,'outside.txt'),'keep this');
  expect((await fetch(f.url.origin+'/api/files')).status).toBe(403);
  const listing=await f.api('/api/files');expect(listing.data.entries).toEqual([{name:'src',directory:true},{name:'README.md',directory:false}]);
  expect((await f.api('/api/file?path=README.md')).data.content).toBe('original');expect((await f.api('/api/file?path=..%2F..%2Foutside.txt')).status).toBe(400);
  const content='Hej 👋 — æøå\n'.repeat(50),body=Buffer.from(JSON.stringify({path:'README.md',content})),emoji=body.indexOf(Buffer.from('👋'));
  const result=await new Promise<number>((resolve,reject)=>{const req=request(f.url.origin+'/api/file',{method:'POST',headers:f.headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.write(body.subarray(0,emoji+1));setTimeout(()=>req.end(body.subarray(emoji+1)),10);});
  expect(result).toBe(200);expect(await readFile(join(project,'README.md'),'utf8')).toBe(content);
  expect((await f.api('/api/file',{path:'../../outside.txt',content:'bad'})).status).toBe(400);expect(await readFile(join(f.root,'outside.txt'),'utf8')).toBe('keep this');
 }finally{await f.close();}
});
it('blocks manual edits and new conversations during model work and retains file contents',async()=>{
 const f=await fixture();try {
  await writeFile(join(f.root,'app/project/file.txt'),'keep');
  const started=vi.fn();vi.spyOn(Ollama.prototype,'complete').mockImplementation(async(_messages,signal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
  await f.app.start();expect((await f.api('/api/task',{text:'Inspect file.txt'})).status).toBe(202);await vi.waitFor(()=>expect(started).toHaveBeenCalledOnce());
  expect((await f.api('/api/file',{path:'file.txt',content:'changed'})).status).toBe(409);expect((await f.api('/api/session/reset',{})).status).toBe(409);
  expect(await readFile(join(f.root,'app/project/file.txt'),'utf8')).toBe('keep');await f.api('/api/cancel',{});
 }finally{await f.close();}
});
