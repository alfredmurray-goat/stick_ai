import {mkdir,lstat,realpath,readFile,open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function extensionDirectory(root:string):Promise<string>{
 let path=await realpath(root);for(const name of ['logs','extensions']){path=join(path,name);await mkdir(path,{recursive:true});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw Error('The extension settings directory is unsafe.');}return path;
}
export async function readExtensionJson(root:string,name:string):Promise<unknown>{
 const path=join(await extensionDirectory(root),name);try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>262144)throw Error('Invalid extension settings.');return JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
export async function writeExtensionJson(root:string,name:string,value:unknown):Promise<void>{
 const folder=await extensionDirectory(root),target=join(folder,name),temporary=join(folder,'.settings-'+randomUUID()+'.tmp'),text=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(text)>262144)throw Error('Extension settings are too large.');
 try{const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Invalid extension settings.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const file=await open(temporary,'wx',0o600);try{await file.writeFile(text);await file.sync();await file.close();await rename(temporary,target);}finally{await file.close().catch(()=>{});await rm(temporary,{force:true});}
}
