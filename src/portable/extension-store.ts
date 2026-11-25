import {mkdir,lstat,realpath,readFile,open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openNativeState,type NativeState} from '../../experimental/stellan-runtime/state.mjs';

// When the package has a verified Stellan-Host, settings live in its state store (one record per settings file)
// instead of JSON files written by Node. Older files are carried over on first read and then left alone.
const hosts=new Map<string,Promise<NativeState|undefined>>();
const revisions=new Map<string,string>();
const settingsKey=(name:string)=>{const h=createHash('sha256').update(`settings:${name}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${'89ab'[parseInt(h[16]!,16)%4]}${h.slice(17,20)}-${h.slice(20,32)}`;};
export function useHostSettings(root:string,host:{executable:string;sha256:string}|undefined,log:(error:unknown)=>void=()=>{}):void{
 if(!host)return;
 hosts.set(root,extensionDirectory(root).then(folder=>openNativeState({executable:host.executable,executableSha256:host.sha256,root:folder})).catch(error=>{log(error);return undefined;}));
}
export async function closeHostSettings(root:string):Promise<void>{const state=await hosts.get(root);hosts.delete(root);await state?.close();}
async function hostGet(state:NativeState,name:string):Promise<string|undefined>{const record=await state.get(settingsKey(name));revisions.set(name,record.revision);return record.exists&&record.text?record.text:undefined;}
async function hostPut(state:NativeState,name:string,text:string):Promise<void>{
 if(Buffer.byteLength(text)>65536)throw Error('These settings are too large to save. Remove some entries and try again.');
 if(!revisions.has(name))await hostGet(state,name);
 try{revisions.set(name,(await state.put(settingsKey(name),revisions.get(name)!,text)).revision);}
 catch(error){if(!(error as {conflict?:boolean}).conflict)throw error;await hostGet(state,name);revisions.set(name,(await state.put(settingsKey(name),revisions.get(name)!,text)).revision);}
}
export async function extensionDirectory(root:string):Promise<string>{
 let path=await realpath(root);for(const name of ['logs','extensions']){path=join(path,name);await mkdir(path,{recursive:true});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw Error('The extension settings directory is unsafe.');}return path;
}
export async function readExtensionJson(root:string,name:string):Promise<unknown>{
 const state=await hosts.get(root);
 if(state){const text=await hostGet(state,name);if(text!==undefined)return JSON.parse(text);const legacy=await readFileJson(root,name);if(legacy!==undefined)await hostPut(state,name,JSON.stringify(legacy,null,2)+'\n');return legacy;}
 return readFileJson(root,name);
}
async function readFileJson(root:string,name:string):Promise<unknown>{
 const path=join(await extensionDirectory(root),name);try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>262144)throw Error('Invalid extension settings.');return JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
export async function writeExtensionJson(root:string,name:string,value:unknown):Promise<void>{
 const state=await hosts.get(root);
 if(state){const text=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(text)>262144)throw Error('Extension settings are too large.');await hostPut(state,name,text);return;}
 const folder=await extensionDirectory(root),target=join(folder,name),temporary=join(folder,'.settings-'+randomUUID()+'.tmp'),text=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(text)>262144)throw Error('Extension settings are too large.');
 try{const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Invalid extension settings.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const file=await open(temporary,'wx',0o600);try{await file.writeFile(text);await file.sync();await file.close();await rename(temporary,target);}finally{await file.close().catch(()=>{});await rm(temporary,{force:true});}
}
