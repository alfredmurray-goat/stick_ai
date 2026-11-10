import {expect,it,vi} from 'vitest';
import {cp,mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {zipSync} from 'fflate';
import {webApp} from '../src/portable/web.js';
import {GitHubClient} from '../src/portable/github-client.js';
import type {ManagedEngine} from '../src/portable/engine.js';
it('authenticates repository routes, switches isolated projects and reviews files without exposing the session token',async()=>{
  const root=await mkdtemp(join(tmpdir(),'stick-github-web-'));await cp(resolve('portable/ui'),join(root,'app/ui'),{recursive:true});
  const repo={id:1,owner:'owner',name:'repo',fullName:'owner/repo',defaultBranch:'main',private:true,canPush:true};
  const content='original';const sha=createHash('sha1').update(`blob ${content.length}\0${content}`).digest('hex');
  const spies=[vi.spyOn(GitHubClient.prototype,'repository').mockResolvedValue(repo),vi.spyOn(GitHubClient.prototype,'base').mockResolvedValue({branch:'main',commit:'a'.repeat(40),tree:'b'.repeat(40)}),vi.spyOn(GitHubClient.prototype,'tree').mockResolvedValue([{path:'README.md',mode:'100644',type:'blob',sha}]),vi.spyOn(GitHubClient.prototype,'archive').mockResolvedValue(Buffer.from(zipSync({'root/README.md':Buffer.from(content)})))];
  const app=await webApp({root,engine:{active:null} as unknown as ManagedEngine,bytes:8*1024**3,choices:['stellan-1-lite'],noSwap:false,report:vi.fn(),log:vi.fn(),stop:async()=>{}});const url=new URL(app.url);
  const api=async(path:string,body?:object)=>{const response=await fetch(url.origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+url.hash.slice(1),Origin:url.origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  try {
    expect((await fetch(url.origin+'/api/github/workspaces')).status).toBe(403);
    const connected=await api('/api/github/connect',{repository:'owner/repo',branch:'',token:'not_for_the_model'});expect(connected.status).toBe(200);expect(connected.data.workspace.repository).toBe('owner/repo');
    const workspace=join(root,'logs/github/workspaces',connected.data.workspace.id,'files');
    await writeFile(join(workspace,'README.md'),'repo edit');
    await writeFile(join(root,'app/project','local.txt'),'local stays');
    const review=await api('/api/github/review',{});expect(review.data.changes[0]).toMatchObject({path:'README.md',before:'original',after:'repo edit'});
    const state=await api('/api/state');expect(state.data.repository.repository).toBe('owner/repo');expect(JSON.stringify(state)).not.toContain('not_for_the_model');
    await api('/api/github/disconnect',{});expect((await api('/api/state')).data.repository).toBeNull();expect(await readFile(join(workspace,'README.md'),'utf8')).toBe('repo edit');expect(await readFile(join(root,'app/project/local.txt'),'utf8')).toBe('local stays');
    const resumed=await api('/api/github/resume',{id:connected.data.workspace.id,token:''});expect(resumed.data.workspace.authenticated).toBe(false);
    expect((await api('/api/github/workspaces')).data.workspaces).toHaveLength(1);
  }finally {await app.close();spies.forEach(s=>s.mockRestore());await rm(root,{recursive:true,force:true});}
});
