import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import ignore from 'ignore';
import { Sandbox } from '../sandbox/paths.js';
import { GitHubClient, GitHubError, type GitHubRepo, type GitHubBase, type GitHubTreeEntry } from './github-client.js';
const MAX_FILE=8*1024**2, MAX_TOTAL=256*1024**2, MAX_FILES=20000;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const gitHash=(bytes:Buffer)=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function safePath(path:string):boolean { return path.length<1024 && path.split('/').every(p=> Boolean(p) && !['.','..','.git','.stick'].includes(p.toLowerCase()) && !/[\\\x00-\x1f\x7f:<>"|?*]|[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)); }
interface Stored { format:1; id:string; repo:GitHubRepo; base:GitHubBase; files:{path:string;sha:string;mode:string}[]; remote?:{branch:string;commit:string;tree:string;digest:string;pr?:{url:string;number:number}} }
export interface RepoChange {path:string;kind:'added'|'modified'|'deleted';before:string;after:string;binary:boolean;truncated:boolean}
interface Snapshot {digest:string;changes:RepoChange[];entries:{path:string;mode:string;bytes:Buffer|null}[]}
/** Archive paths and bytes must match the immutable Git tree; no archive extraction to disk. */
export function repositoryFiles(archive:Buffer,tree:GitHubTreeEntry[]):Map<string,Buffer> {
  if(tree.some(e=> e.type==='commit' || e.type==='blob' && !['100644','100755'].includes(e.mode))) throw new GitHubError('This repository contains symlinks or submodules. The current portable workspace supports regular files only.');
  const blobs=tree.filter(e=>e.type==='blob');
  if(blobs.length>MAX_FILES || blobs.some(e=>!safePath(e.path))) throw new GitHubError('This repository contains unsupported paths or too many files.');
  const byPath=new Map(blobs.map(e=>[e.path,e])); const seen=new Set<string>(); let expanded=0,count=0;
  const result=new Map<string,Buffer>(); let prefix='';
  const files=unzipSync(archive,{filter:file=>{
    // Bound expansion before decompression, including entries we do not materialize.
    expanded+=file.originalSize; count++;
    if(expanded>MAX_TOTAL || count>MAX_FILES*2 || file.originalSize>MAX_FILE) throw new GitHubError('Repository exceeds workspace limits (8 MB per file, 256 MB expanded).');
    const slash=file.name.indexOf('/');
    if(slash<1 || file.name.includes('\\') || file.name.includes('\0')) throw new GitHubError('Unsafe repository archive path.');
    const top=file.name.slice(0,slash); if(prefix && prefix!==top) throw new GitHubError('Unexpected repository archive layout.'); prefix=top;
    const path=file.name.slice(slash+1);
    if(!path || path.endsWith('/')) { if(path && !safePath(path.slice(0,-1))) throw new GitHubError('Unsafe archive directory.'); return false; }
    if(!safePath(path) || !byPath.has(path) || seen.has(path.toLowerCase())) throw new GitHubError('Archive does not match the Git source tree or has ambiguous paths.');
    seen.add(path.toLowerCase()); return true;
  }});
  for(const [name,raw] of Object.entries(files)) {
    const path=name.slice(name.indexOf('/')+1), bytes=Buffer.from(raw), entry=byPath.get(path)!;
    if(gitHash(bytes)!==entry.sha) throw new GitHubError('Repository archive differs from its pinned Git commit. LFS archive substitution is not supported.');
    result.set(path,bytes);
  }
  // GitHub export-ignore can omit tracked files; refuse instead of treating omissions as deletions.
  if(result.size!==blobs.length) throw new GitHubError('The archive omits tracked files (for example export-ignore). This repository needs a complete regular-file archive.');
  return result;
}
export class GitHubWorkspaces {
  private client=new GitHubClient();
  private current:Stored|undefined;
  private reviewed:string|undefined;
  constructor(private readonly root:string) {}
  private folder(id:string):string { if(!/^[a-f0-9-]{36}$/.test(id)) throw new GitHubError('Invalid workspace identity.'); return join(this.root,id); }
  private async save():Promise<void> { if(!this.current)return; const file=join(this.folder(this.current.id),'workspace.json'); await writeFile(file+'.tmp',JSON.stringify(this.current),{mode:0o600}); await rename(file+'.tmp',file); }
  view() { const w=this.current; return w?{id:w.id,repository:w.repo.fullName,branch:w.base.branch,commit:w.base.commit,private:w.repo.private,authenticated:this.client.authenticated,pullRequest:w.remote?.pr ?? null,files:w.files.length}:null; }
  async list() { await mkdir(this.root,{recursive:true}); const result=[]; for(const id of await readdir(this.root)) { if(!/^[a-f0-9-]{36}$/.test(id))continue; try { const w=JSON.parse(await readFile(join(this.folder(id),'workspace.json'),'utf8')) as Stored; if(w.format===1 && w.id===id) result.push({id,repository:w.repo.fullName,branch:w.base.branch}); } catch{} } return result; }
  async connect(input:string,branch:string,token:string,signal:AbortSignal):Promise<Sandbox> {
    const client=new GitHubClient(token), repo=await client.repository(input,signal);
    const base=await client.base(repo,branch.trim()||repo.defaultBranch,signal);
    const tree=await client.tree(repo,base.tree,signal);
    const files=repositoryFiles(await client.archive(repo,base.commit,signal),tree);
    const id=randomUUID(), folder=this.folder(id); await mkdir(join(folder,'files'),{recursive:true});
    try {
      for(const [path,bytes] of files) { signal.throwIfAborted(); for(const section of ['files','baseline']) { const file=join(folder,section,path); await mkdir(dirname(file),{recursive:true}); await writeFile(file,bytes,{flag:'wx'}); } }
      const next:Stored={format:1,id,repo,base,files:tree.filter(e=>e.type==='blob').map(e=>({path:e.path,sha:e.sha,mode:e.mode}))};
      await writeFile(join(folder,'workspace.json'),JSON.stringify(next),{mode:0o600,flag:'wx'});
      this.current=next;this.client=client;this.reviewed=undefined;return Sandbox.create(join(folder,'files'));
    } catch(error) { await rm(folder,{recursive:true,force:true});throw error; }
  }
  async resume(id:string,token:string,signal:AbortSignal):Promise<Sandbox> {
    const folder=this.folder(id), w=JSON.parse(await readFile(join(folder,'workspace.json'),'utf8')) as Stored;
    if(w.format!==1 || w.id!==id || !Array.isArray(w.files) || w.files.length>MAX_FILES || w.files.some(e=>!safePath(e.path) || !/^[a-f0-9]{40}$/.test(e.sha) || !['100644','100755'].includes(e.mode))) throw new GitHubError('Invalid saved workspace.');
    const client=new GitHubClient(token), repo=await client.repository(w.repo.fullName,signal);
    if(repo.id!==w.repo.id) throw new GitHubError('The saved repository identity changed. Connect a fresh workspace.');
    const box=await Sandbox.create(join(folder,'files'));
    this.current=w;this.client=client;this.reviewed=undefined;return box;
  }
  disconnect():void { this.current=undefined;this.client=new GitHubClient();this.reviewed=undefined; }
  private async snapshot():Promise<Snapshot> {
    const w=this.current;if(!w)throw new GitHubError('Connect a repository first.');
    const box=await Sandbox.create(join(this.folder(w.id),'files')), tracked=new Map(w.files.map(f=>[f.path,f]));
    const files=new Map<string,Buffer>(); let total=0,count=0;
    const walk=async(path:string,rules:{base:string;matcher:ReturnType<typeof ignore>}[]):Promise<void>=>{
      const directory=path?await box.path(path):box.root;
      const names=await readdir(directory); let inherited=rules;
      if(names.includes('.gitignore')) { const file=await box.path(path?path+'/.gitignore':'.gitignore'); const stat=await lstat(file); if(stat.isFile() && stat.size<=MAX_FILE) inherited=[...rules,{base:path,matcher:ignore().add(await readFile(file,'utf8'))}]; }
      for(const name of names.sort()) {
        if(['.git','.stick'].includes(name.toLowerCase()))continue;
        const rel=path?path+'/'+name:name;
        if(!safePath(rel))throw new GitHubError(`Unsupported workspace path: ${rel}`);
        const raw=await lstat(join(box.root,rel)); if(raw.isSymbolicLink() || !raw.isDirectory() && (!raw.isFile() || raw.nlink!==1))throw new GitHubError(`Workspace contains a link or special file: ${rel}`);
        const ignored=inherited.some(rule=>rule.matcher.ignores((rule.base?rel.slice(rule.base.length+1):rel)+(raw.isDirectory()?'/':'')));
        const trackedHere=tracked.has(rel) || raw.isDirectory() && w.files.some(f=>f.path.startsWith(rel+'/'));
        if(ignored && !trackedHere)continue;
        if(++count>MAX_FILES*2)throw new GitHubError('Too many workspace files.');
        if(raw.isDirectory()) {await walk(rel,inherited);continue;}
        total+=raw.size;if(raw.size>MAX_FILE || total>MAX_TOTAL)throw new GitHubError('Workspace exceeds the 8 MB file or 256 MB total limit.');
        files.set(rel,await readFile(await box.path(rel)));
      }
    };
    await walk('',[]);
    const entries:Snapshot['entries']=[],changes:RepoChange[]=[];
    for(const path of [...new Set([...tracked.keys(),...files.keys()])].sort()) {
      const original=tracked.get(path),bytes=files.get(path);
      if(original && bytes && gitHash(bytes)===original.sha)continue;
      if(!original && !bytes)continue;
      // Baseline text comes from the immutable archive cache, never from the editable tree.
      entries.push({path,mode:original?.mode??'100644',bytes:bytes??null});
      const prior=original?await readFile(join(this.folder(w.id),'baseline',path)):undefined;
      if(original && (!prior || gitHash(prior)!==original.sha))throw new GitHubError('Workspace baseline integrity failed.');
      const binary=Boolean(bytes && (!isUtf8(bytes) || bytes.includes(0)) || prior && (!isUtf8(prior) || prior.includes(0)));
      const after=bytes&&!binary?bytes.toString('utf8'):'';
      changes.push({path,kind:original?bytes?'modified':'deleted':'added',before:prior&&!binary?prior.toString('utf8').slice(0,12000):'',after:after.slice(0,12000),binary,truncated:after.length>12000 || Boolean(prior && prior.length>12000)});
    }
    const checksum=createHash('sha256');for(const e of entries)checksum.update(JSON.stringify([e.path,e.mode,e.bytes?digest(e.bytes):null]));
    return {digest:checksum.digest('hex'),entries,changes};
  }
  async review() { const value=await this.snapshot();this.reviewed=value.digest;return {digest:value.digest,changes:value.changes,workspace:this.view(),alreadyPublished:this.current?.remote?.digest===value.digest}; }
  async publish(reviewDigest:string,title:string,body:string,signal:AbortSignal) {
    const w=this.current;if(!w || !this.client.authenticated)throw new GitHubError('Connect a GitHub token with Contents and Pull requests write access.');
    if(!this.reviewed || this.reviewed!==reviewDigest)throw new GitHubError('Review the current changes before publishing.');
    const snapshot=await this.snapshot();if(snapshot.digest!==reviewDigest)throw new GitHubError('Files changed since review. Review the changes again.');
    if(!snapshot.entries.length)throw new GitHubError('There are no changes to publish.');
    if(!title.trim() || title.length>256 || body.length>16000)throw new GitHubError('Enter a pull-request title of at most 256 characters.');
    const repo=await this.client.repository(w.repo.fullName,signal);if(repo.id!==w.repo.id || repo.canPush===false)throw new GitHubError('This token cannot push to the connected repository.');
    if(w.remote?.pr)await this.client.pullRequestOpen(repo,w.remote.pr.number,w.remote.branch,signal);
    if(!w.remote || w.remote.digest!==snapshot.digest) {
      const entries=[];for(const e of snapshot.entries) {signal.throwIfAborted();entries.push({path:e.path,mode:e.mode,type:'blob' as const,sha:e.bytes?await this.client.blob(repo,e.bytes,signal):null});}
      const tree=await this.client.createTree(repo,w.base.tree,entries,signal);
      const commit=await this.client.commit(repo,tree,w.remote?.commit??w.base.commit,title.trim(),signal);
      const branch=w.remote?.branch??'stick-ai/'+Date.now().toString(36)+'-'+randomUUID().slice(0,8);
      if(w.remote)await this.client.advanceBranch(repo,branch,w.remote.commit,commit,signal);else await this.client.branch(repo,branch,commit,signal);
      w.remote={...w.remote,branch,commit,tree,digest:snapshot.digest};await this.save();
    }
    const pr=w.remote.pr??await this.client.existingPullRequest(repo,w.remote.branch,w.base.branch,signal)??await this.client.pullRequest(repo,w.remote.branch,w.base.branch,title.trim(),body,signal);
    w.remote.pr=pr;await this.save();this.reviewed=undefined;return pr;
  }
}
