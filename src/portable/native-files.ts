import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {openNativeWorkspace,type NativeWorkspace} from '../../experimental/stellan-runtime/workspace.mjs';
import {targetFor} from './platform.js';
import type {FileBackend} from '../tools/index.js';
import type {Manifest} from './integrity.js';

/** A package opting into Host must have a trusted native executable; it never silently falls back. */
export function nativeFileBackend(root:string,project:string):FileBackend|undefined {
 let manifest:Manifest;
 try{
  const path=join(root,'manifest.json'),info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4000000)throw Error('Unsafe package manifest');
  manifest=JSON.parse(readFileSync(path,'utf8')) as Manifest;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(manifest.nativeHost===undefined)return;
 if(manifest.nativeHost!==true)throw Error('Unsupported native host package');
 const target=targetFor(process.platform,process.arch),path=`bin/${target}/stellan-host${process.platform==='win32'?'.exe':''}`;
 const record=manifest.files?.find(file=>file.path===path);
 if(!record?.executable||!(/^[a-f0-9]{64}$/).test(record.sha256))throw Error('The package is missing its trusted native host');
 return new NativeFiles(join(root,path),record.sha256,project);
}
class NativeFiles implements FileBackend {
 private current:Promise<NativeWorkspace>|undefined;
 private lifetime=new AbortController();
 private disposed=false;
 constructor(private executable:string,private sha256:string,private project:string){}
 async execute(name:string,args:Record<string,unknown>,signal:AbortSignal,approve:(signal:AbortSignal)=>Promise<boolean>):Promise<string>{
  if(this.disposed)throw Error('Native file service is closed');
  const control=AbortSignal.any([signal,this.lifetime.signal]);control.throwIfAborted();
  const fields:Record<string,string[]>={read_file:['path'],list_dir:['path'],search_files:['query'],write_file:['path','content'],edit_file:['path','old','new']};
  const names=fields[name];if(!names)throw Error('Unsupported native file operation');
  const values=names.map(key=>{if(typeof args[key]!=='string')throw Error(`Missing string argument: ${key}`);return args[key] as string;});
  for(let attempt=0;attempt<2;attempt++){
   if(!this.current){
    const opening=openNativeWorkspace({executable:this.executable,executableSha256:this.sha256,root:this.project,signal:control});this.current=opening;
    void opening.then(client=>{void client.closed.then(()=>{if(this.current===opening)this.current=undefined;});},()=>{if(this.current===opening)this.current=undefined;});
   }
   const opening=this.current,client=await opening;
   if(client.isClosed){if(this.current===opening)this.current=undefined;continue;}
   return client.execute(name,values,{signal:control,approve:async(_proposal,approvalSignal)=>await approve(approvalSignal??control)===true});
  }
  throw Error('Native file service closed before the operation started');
 }
 async close(){this.disposed=true;this.lifetime.abort();const client=await this.current?.catch(()=>undefined);await client?.close();this.current=undefined;}
}
