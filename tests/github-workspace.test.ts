import { expect,it,vi,afterEach } from 'vitest';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdtemp,writeFile,readFile,rm,mkdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryFiles,GitHubWorkspaces } from '../src/portable/github-workspace.js';
import type { GitHubTreeEntry } from '../src/portable/github-client.js';
const hash=(s:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const tree=(path='README.md',content='original',mode='100644'):GitHubTreeEntry[]=>[{path,mode,type:'blob',sha:hash(content)}];
const zip=(files:Record<string,string>)=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p,v])=>[p,Buffer.from(v)]))));
const signal=()=>new AbortController().signal;
afterEach(()=>vi.unstubAllGlobals());
it('matches extracted bytes to the exact immutable Git tree',()=>{
  expect(repositoryFiles(zip({'owner-repo-abc/README.md':'original'}),tree()).get('README.md')?.toString()).toBe('original');
  expect(()=>repositoryFiles(zip({'owner-repo-abc/README.md':'tampered'}),tree())).toThrow('pinned Git commit');
  expect(()=>repositoryFiles(zip({}),tree())).toThrow('omits tracked');
});
it.each(['../escape','dir/../../escape','C:/escape','.git/config','a\\b','CON','trailing.'])('rejects unsafe portable paths %s',path=>{
  expect(()=>repositoryFiles(zip({['root/'+path]:'original'}),tree(path))).toThrow();
});
it('rejects symbolic links, submodules, case collisions and archive bombs',()=>{
  expect(()=>repositoryFiles(zip({'root/README.md':'original'}),tree('README.md','original','120000'))).toThrow('symlinks');
  expect(()=>repositoryFiles(zip({}),[{path:'module',mode:'160000',type:'commit',sha:'a'.repeat(40)}])).toThrow('submodules');
  expect(()=>repositoryFiles(zip({'root/README.md':'original','root/readme.md':'original'}),[...tree(),...tree('readme.md')])).toThrow('ambiguous');
  const content='a'.repeat(8*1024**2+1);expect(()=>repositoryFiles(zip({'root/large':'a'.repeat(content.length)}),tree('large',content))).toThrow('8 MB');
});
function fakeGitHub(files:Record<string,string>={'README.md':'original','.gitignore':'ignored/\n'}) {
  const calls:{method:string;url:string;body:any}[]=[];const commit='a'.repeat(40),sourceTree='b'.repeat(40);
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({method,url,body});
    let response:any;
    if(url.endsWith('/repos/owner/repo'))response={id:1,full_name:'owner/repo',default_branch:'main',private:true,permissions:{push:true}};
    else if(url.endsWith('/branches/main'))response={commit:{sha:commit}};
    else if(url.endsWith('/git/commits/'+commit))response={tree:{sha:sourceTree}};
    else if(url.includes('/git/trees/') && method==='GET')response={tree:Object.entries(files).flatMap(([p,v])=>tree(p,v)),truncated:false};
    else if(url.includes('/zipball/'))return new Response(zip(Object.fromEntries(Object.entries(files).map(([p,v])=>['root/'+p,v]))));
    else if(url.endsWith('/git/blobs'))response={sha:hash(Buffer.from(body.content,'base64').toString())};
    else if(url.endsWith('/git/trees'))response={sha:'c'.repeat(40)};
    else if(url.endsWith('/git/commits'))response={sha:'d'.repeat(40)};
    else if(url.endsWith('/git/refs'))response={ref:body.ref};
    else if(url.includes('/pulls?'))response=[];
    else if(url.endsWith('/pulls/5'))response={state:'open',head:{ref:calls.find(c=>c.url.endsWith('/git/refs') && c.method==='POST')!.body.ref.slice(11),repo:{id:1}}};
    else if(url.includes('/git/refs/heads/') && method==='GET')response={object:{sha:'d'.repeat(40)}};
    else if(url.includes('/git/refs/heads/') && method==='PATCH')response={ref:'refs/heads/stick-ai/task'};
    else if(url.endsWith('/pulls'))response={html_url:'https://github.com/owner/repo/pull/5',number:5};
    else throw new Error('Unexpected mocked request '+url);
    return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
  }));return calls;
}
it('reviews exact changes, ignores untracked artifacts, refuses stale reviews and publishes only a draft on a new branch',async()=>{
  const root=await mkdtemp(join(tmpdir(),'stick-github-'));
  try {
    const calls=fakeGitHub(),manager=new GitHubWorkspaces(root),box=await manager.connect('owner/repo','','session_secret',signal());
    await writeFile(join(box.root,'README.md'),'first edit');await mkdir(join(box.root,'ignored'));await writeFile(join(box.root,'ignored','build.bin'),'ignored');
    let review=await manager.review();expect(review.changes).toEqual([expect.objectContaining({path:'README.md',before:'original',after:'first edit',kind:'modified'})]);
    await writeFile(join(box.root,'README.md'),'second edit');await expect(manager.publish(review.digest,'Change','body',signal())).rejects.toThrow('Files changed since review');
    expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
    review=await manager.review();expect(await manager.publish(review.digest,'Change','body',signal())).toEqual({url:'https://github.com/owner/repo/pull/5',number:5});
    const branch=calls.find(c=>c.url.endsWith('/git/refs'))!;expect(branch.body.ref).toMatch(/^refs\/heads\/stick-ai\//);
    const commit=calls.find(c=>c.url.endsWith('/git/commits') && c.method==='POST')!;expect(commit.body.parents).toEqual(['a'.repeat(40)]);
    const pull=calls.find(c=>c.url.endsWith('/pulls'))!;expect(pull.body).toMatchObject({draft:true,base:'main',title:'Change'});
    expect(calls.every(c=>c.method!=='PATCH' && c.method!=='DELETE')).toBe(true);
    await writeFile(join(box.root,'README.md'),'third edit');review=await manager.review();expect((await manager.publish(review.digest,'Follow up','',signal())).number).toBe(5);expect(calls.filter(c=>c.method==='POST' && c.url.endsWith('/pulls'))).toHaveLength(1);expect(calls.find(c=>c.method==='PATCH')?.body).toEqual({sha:'d'.repeat(40),force:false});
    const saved=await manager.list();expect(saved).toHaveLength(1);
    const metadata=await readFile(join(root,saved[0]!.id,'workspace.json'),'utf8');expect(metadata).not.toContain('session_secret');
    manager.disconnect();expect(manager.view()).toBeNull();const restored=await manager.resume(saved[0]!.id,'',signal());expect(await readFile(join(restored.root,'README.md'),'utf8')).toBe('third edit');expect(manager.view()?.authenticated).toBe(false);
    review=await manager.review();await expect(manager.publish(review.digest,'Change','body',signal())).rejects.toThrow('token');
  } finally {await rm(root,{recursive:true,force:true});}
});
it('detects tracked deletions and prevents publishing workspace symlinks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'stick-github-'));
  try {fakeGitHub();const manager=new GitHubWorkspaces(root),box=await manager.connect('owner/repo','','token',signal());await rm(join(box.root,'README.md'));const review=await manager.review();expect(review.changes[0]).toMatchObject({path:'README.md',kind:'deleted',before:'original',after:''});
    if(process.platform!=='win32') {await symlink('/tmp',join(box.root,'escape'));await expect(manager.review()).rejects.toThrow('link or special');}
  }finally {await rm(root,{recursive:true,force:true});}
});
