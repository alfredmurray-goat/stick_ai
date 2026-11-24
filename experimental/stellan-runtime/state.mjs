import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/**
 * Owner-pipe client for `stellan-host --state-store`: small private records (chat memory, session state)
 * saved by the native Host with compare-and-swap revisions. The executable's SHA-256 comes from the
 * trusted package manifest and is checked before launch. No network port is opened.
 */
export async function openNativeState({executable,executableSha256,root,signal,startupTimeoutMs=10000}) {
 if(!/^[a-f0-9]{64}$/.test(executableSha256??''))throw Error('A trusted host executable SHA256 is required');
 signal?.throwIfAborted();
 const binary=resolve(executable),info=await lstat(binary);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Unsafe native host executable');
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(binary)){signal?.throwIfAborted();hash.update(chunk);}
 if(hash.digest('hex')!==executableSha256)throw Error('Native host executable hash mismatch');
 const folder=await realpath(root);
 const child=spawn(binary,['--state-store',folder],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
 const decoder=new TextDecoder('utf-8',{fatal:true});
 let ready=false,stopped=false,next=0,buffer='',startupTimer,killTimer,acceptReady,rejectReady,acceptClosed,stderr='';
 const waiting=new Map();let queue=Promise.resolve();
 const initialized=new Promise((accept,reject)=>{acceptReady=accept;rejectReady=reject;});
 const closed=new Promise(accept=>{acceptClosed=accept;});
 function fail(error){
  if(stopped)return;stopped=true;clearTimeout(startupTimer);rejectReady(error);
  for(const {reject} of waiting.values())reject(error);waiting.clear();
  child.stdin.destroy();child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref?.();
 }
 function event(line){
  const value=JSON.parse(line);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid native state response');
  if(!ready){
   if(value.event!=='ready'||value.protocol!==1||value.scope!=='session-state'||value.node_required!==false||value.max_record_bytes!==65536)throw Error('Unsupported native state protocol');
   ready=true;clearTimeout(startupTimer);acceptReady();return;
  }
  if(value.event==='stopped')return;
  const request=waiting.get(value.request_id);if(!request)throw Error('Unexpected native state response');
  waiting.delete(value.request_id);
  if(value.event==='error'&&typeof value.message==='string')request.reject(Object.assign(Error(value.message),{conflict:/revision conflict/i.test(value.message)}));
  else if(value.event==='state'&&typeof value.exists==='boolean'&&typeof value.text==='string'&&(value.revision==='missing'||/^[a-f0-9]{64}$/.test(value.revision)))request.accept({exists:value.exists,revision:value.revision,text:value.text});
  else if(value.event==='saved'&&/^[a-f0-9]{64}$/.test(value.revision))request.accept({revision:value.revision});
  else throw Error('Malformed native state response');
 }
 child.stdout.on('data',chunk=>{
  if(stopped)return;
  try{
   buffer+=decoder.decode(chunk,{stream:true});
   if(buffer.length>1024*1024)throw Error('Native state response is too large');
   let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);event(line);}
  }catch(error){fail(error);}
 });
 child.stderr.on('data',chunk=>{if(stderr.length<2000)stderr+=chunk.toString('utf8').slice(0,2000);});
 child.stdin.on('error',error=>fail(error));child.on('error',error=>fail(error));
 child.once('close',()=>{fail(Error(stderr.includes('owned')?'Chat memory is already open in another Stick AI window.':'Native state host disconnected'));clearTimeout(killTimer);acceptClosed();});
 startupTimer=setTimeout(()=>fail(Error('Native state host did not become ready')),startupTimeoutMs);startupTimer.unref?.();
 const abort=()=>fail(signal.reason??Error('Native state host cancelled'));signal?.addEventListener('abort',abort,{once:true});
 await initialized;
 function request(line){
  const run=queue.then(()=>new Promise((accept,reject)=>{
   if(stopped){reject(Error('Native state host is unavailable'));return;}
   const id=++next;waiting.set(id,{accept,reject});
   child.stdin.write(`${id} ${line}\n`,error=>{if(error)fail(error);});
  }));
  queue=run.catch(()=>undefined);return run;
 }
 const checkKey=key=>{if(!uuid.test(key))throw Error('State record ID must be a lowercase UUID');};
 return {
  get closed(){return closed;},
  get isClosed(){return stopped;},
  async get(key){checkKey(key);return request(`state_get ${key}`);},
  async put(key,revision,text){
   checkKey(key);if(revision!=='missing'&&!/^[a-f0-9]{64}$/.test(revision))throw Error('Invalid state revision');
   if(Buffer.byteLength(text)>65536)throw Error('State record exceeds 64 KiB');
   return request(`state_put ${key} ${revision} ${Buffer.from(text,'utf8').toString('hex')||'-'}`);
  },
  async close(){
   signal?.removeEventListener('abort',abort);
   if(!stopped){await queue;if(!stopped){child.stdin.write('shutdown\n');child.stdin.end();}}
   const timer=setTimeout(()=>fail(Error('Native state host stopped')),3000);timer.unref?.();
   await closed;clearTimeout(timer);
  }
 };
}
