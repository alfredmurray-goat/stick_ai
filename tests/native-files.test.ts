import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeFileBackend} from '../src/portable/native-files.js';
import {hashFile} from '../src/portable/integrity.js';
import {targetFor} from '../src/portable/platform.js';
import {Tools} from '../src/tools/index.js';
import {Sandbox} from '../src/sandbox/paths.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
if(process.env.STELLAN_REQUIRE_NATIVE_HOST==='1'&&!existsSync(host))throw Error('Required native host integration binary is missing');
it.skipIf(!existsSync(host))('routes real agent file tools through verified Host with mandatory approval and cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stellan-native-files-'));
 let tools:Tools|undefined;
 try{
  const project=join(root,'project'),target=targetFor(process.platform,process.arch),path=`bin/${target}/stellan-host${process.platform==='win32'?'.exe':''}`;
  await mkdir(project);await mkdir(join(root,'bin',target),{recursive:true});await cp(host,join(root,path));
  await writeFile(join(root,'manifest.json'),JSON.stringify({nativeHost:true,files:[{path,...await hashFile(join(root,path)),executable:true}]}));
  let allowed=false,approvals=0;
  tools=new Tools(await Sandbox.create(project),async()=>{approvals++;return allowed;},undefined,undefined,nativeFileBackend(root,project));
  const call=(name:string,args:unknown)=>tools!.execute({id:'test',type:'function',function:{name,arguments:JSON.stringify(args)}},new AbortController().signal);
  expect(await call('write_file',{path:'hello.txt',content:'native text'})).toBe('Denied by user');
  await expect(readFile(join(project,'hello.txt'))).rejects.toThrow();expect(approvals).toBe(1);
  allowed=true;await call('write_file',{path:'hello.txt',content:'native text'});
  expect(await call('read_file',{path:'hello.txt'})).toBe('native text');expect(approvals).toBe(2);
  await call('edit_file',{path:'hello.txt',old:'text',new:'tools'});
  expect(await call('search_files',{query:'native tools'})).toContain('hello.txt:1:native tools');expect(approvals).toBe(3);
  await expect(call('read_file',{path:'../escape'})).rejects.toThrow();
  await tools.close();await expect(call('list_dir',{path:'.'})).rejects.toThrow('closed');
  await writeFile(join(root,path),'tampered host');
  const changed=nativeFileBackend(root,project)!;
  try{await expect(changed.execute('list_dir',{path:'.'},new AbortController().signal,async()=>false)).rejects.toThrow('hash mismatch');}finally{await changed.close();}
 }finally{await tools?.close();await rm(root,{recursive:true,force:true});}
},15000);
it('does not silently replace a declared native host with Node file tools',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stellan-native-policy-'));
 try{
  expect(nativeFileBackend(root,root)).toBeUndefined();
  await writeFile(join(root,'manifest.json'),JSON.stringify({nativeHost:true,files:[]}));
  expect(()=>nativeFileBackend(root,root)).toThrow('trusted native host');
 }finally{await rm(root,{recursive:true,force:true});}
});

it.skipIf(!existsSync(host))('dismisses an unanswered approval when Host exits and reopens before a new operation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stellan-host-idle-'));const previous=process.env.STELLAN_HOST_IDLE_SECONDS;
 let backend:ReturnType<typeof nativeFileBackend>;
 try{
  process.env.STELLAN_HOST_IDLE_SECONDS='1';
  const project=join(root,'project'),target=targetFor(process.platform,process.arch),path=`bin/${target}/stellan-host${process.platform==='win32'?'.exe':''}`;
  await mkdir(project);await mkdir(join(root,'bin',target),{recursive:true});await cp(host,join(root,path));
  await writeFile(join(root,'manifest.json'),JSON.stringify({nativeHost:true,files:[{path,...await hashFile(join(root,path)),executable:true}]}));
  backend=nativeFileBackend(root,project)!;let dismissed=false;
  await expect(backend.execute('write_file',{path:'never.txt',content:'denied'},new AbortController().signal,signal=>new Promise(resolve=>{signal.addEventListener('abort',()=>{dismissed=true;resolve(false);},{once:true});}))).rejects.toThrow();
  expect(dismissed).toBe(true);await expect(readFile(join(project,'never.txt'))).rejects.toThrow();
  expect(await backend.execute('list_dir',{path:'.'},new AbortController().signal,async()=>false)).toBe('');
 }finally{
  if(previous===undefined)delete process.env.STELLAN_HOST_IDLE_SECONDS;else process.env.STELLAN_HOST_IDLE_SECONDS=previous;
  await backend?.close();await rm(root,{recursive:true,force:true});
 }
},10000);
