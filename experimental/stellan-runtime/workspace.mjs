import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Development owner-pipe client. Hash is supplied by the trusted package, never by the child. */
export async function openNativeWorkspace({executable,executableSha256,root,signal,startupTimeoutMs=10000}) {
 if(!/^[a-f0-9]{64}$/.test(executableSha256??''))throw Error('A trusted host executable SHA256 is required');
 if(!Number.isInteger(startupTimeoutMs)||startupTimeoutMs<1)throw Error('Startup timeout must be positive');
 signal?.throwIfAborted();
 const binary=resolve(executable),info=await lstat(binary);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Unsafe native host executable');
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(binary)){signal?.throwIfAborted();hash.update(chunk);}
 if(hash.digest('hex')!==executableSha256)throw Error('Native host executable hash mismatch');
 const project=await realpath(root);signal?.throwIfAborted();
 const child=spawn(binary,['--workspace',project],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
 let ready=false,stopped=false,busy=false,next=0,pending,used=0,buffer=Buffer.alloc(0),killTimer,startupTimer;
 const decoder=new TextDecoder('utf-8',{fatal:true}),limit=7*1024**2,stopping=new AbortController();
 let acceptReady,rejectReady,acceptClosed;
 const initialized=new Promise((accept,reject)=>{acceptReady=accept;rejectReady=reject;});
 const closed=new Promise(accept=>{acceptClosed=accept;});
 function fail(error){
  if(stopped)return;stopped=true;stopping.abort(error);clearTimeout(startupTimer);signal?.removeEventListener('abort',startupAbort);
  rejectReady(error);if(pending){pending.reject(error);pending=undefined;}
  buffer=Buffer.alloc(0);used=0;child.stdin.destroy();child.kill('SIGTERM');
  killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref?.();
 }
 const startupAbort=()=>fail(signal.reason??Error('Native host startup cancelled'));
 signal?.addEventListener('abort',startupAbort,{once:true});
 if(signal?.aborted)startupAbort();
 function event(line){
  const value=JSON.parse(decoder.decode(line));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid native host response');
  if(!ready){
   if(value.event!=='ready'||value.protocol!==1||value.scope!=='workspace-files'||value.writes_require_approval!==true||value.node_required!==false)throw Error('Unsupported native workspace protocol');
   ready=true;clearTimeout(startupTimer);signal?.removeEventListener('abort',startupAbort);acceptReady();return;
  }
  if(!pending||value.request_id!==pending.id)throw Error('Unexpected native host response');
  if(value.event==='result'&&typeof value.text==='string'||value.event==='error'&&typeof value.message==='string'||value.event==='approval_required'&&typeof value.path==='string'&&['write_file','edit_file'].includes(value.operation)&&/^[a-f0-9]{32}$/.test(value.approval_id??'')&&/^[a-f0-9]{64}$/.test(value.after_sha256??'')&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=1048576){
   const current=pending;pending=undefined;current.accept(value);
  }else throw Error('Malformed native workspace response');
 }
 child.stdout.on('data',chunk=>{
  if(stopped)return;
  try{
   let start=0;
   while(start<chunk.length){
    const end=chunk.indexOf(10,start),stop=end<0?chunk.length:end,part=chunk.subarray(start,stop),needed=used+part.length;
    if(needed>limit)throw Error('Native workspace response is too large');
    if(end>=0&&used===0)event(part);
    else{
     if(needed>buffer.length){const grown=Buffer.allocUnsafe(Math.min(limit,Math.max(4096,buffer.length*2,needed)));buffer.copy(grown,0,0,used);buffer=grown;}
     part.copy(buffer,used);used=needed;
     if(end>=0){event(buffer.subarray(0,used));used=0;if(buffer.length>65536)buffer=Buffer.alloc(0);}
    }
    if(stopped)return;if(end<0)break;start=end+1;
   }
  }catch(error){fail(error);}
 });
 // Drain diagnostics without retaining project data or an unbounded error log.
 child.stderr.resume();child.stdin.on('error',error=>fail(error));child.on('error',error=>fail(error));
 child.once('close',()=>{fail(Error('Native workspace host disconnected'));clearTimeout(killTimer);acceptClosed();});
 if(!stopped){startupTimer=setTimeout(()=>fail(Error('Native workspace host did not become ready')),startupTimeoutMs);startupTimer.unref?.();}
 function waitForApproval(work){
  return new Promise((accept,reject)=>{
   const abort=()=>{cleanup();reject(stopping.signal.reason);};
   const cleanup=()=>stopping.signal.removeEventListener('abort',abort);
   stopping.signal.addEventListener('abort',abort,{once:true});
   Promise.resolve(work).then(value=>{cleanup();accept(value);},error=>{cleanup();reject(error);});
   if(stopping.signal.aborted)abort();
  });
 }
 async function request(operation,args,raw=false){
  if(stopped||pending)throw Error('Native workspace host is unavailable');
  const id=++next,line=`${id} ${operation} ${args.map(arg=>raw?arg:Buffer.from(arg,'utf8').toString('hex')||'-').join(' ')}\n`;
  if(Buffer.byteLength(line)>4194304)throw Error('Native workspace request exceeds 4 MiB');
  return new Promise((accept,reject)=>{pending={id,accept,reject};child.stdin.write(line,error=>{if(error)fail(error);});});
 }
 try{await initialized;}catch(error){await closed;throw error;}
 return {
  closed,
  async execute(operation,args,{signal:control,approve}={}){
   if(busy)throw Error('Another native workspace operation is active');
   if(stopped)throw Error('Native workspace host is closed');
   if(!['read_file','list_dir','search_files','write_file','edit_file'].includes(operation))throw Error('Unsupported native workspace operation');
   const count=operation==='write_file'?2:operation==='edit_file'?3:1;
   if(!Array.isArray(args)||args.length!==count||args.some(value=>typeof value!=='string'))throw Error('Invalid native workspace arguments');
   control?.throwIfAborted();busy=true;
   const abort=()=>fail(control.reason??Error('Native workspace operation cancelled'));
   control?.addEventListener('abort',abort,{once:true});
   try{
    if(control?.aborted)abort();
    let response=await request(operation,args);
    if(response.event==='approval_required'){
     if(!['write_file','edit_file'].includes(operation)||response.operation!==operation||response.path!==args[0]){const error=Error('Unexpected native workspace approval');fail(error);throw error;}
     if(operation==='write_file'&&(response.bytes!==Buffer.byteLength(args[1])||response.after_sha256!==createHash('sha256').update(args[1]).digest('hex'))){const error=Error('Native workspace proposal does not match the requested content');fail(error);throw error;}
     let accepted=false;
     try{accepted=approve ? (await waitForApproval(Promise.resolve().then(()=>approve({...response},AbortSignal.any([stopping.signal,...(control?[control]:[])]))))) === true : false;}
     catch(error){if(!stopped)await request('deny',[response.approval_id],true);throw error;}
     control?.throwIfAborted();
     response=await request(accepted?'approve':'deny',[response.approval_id],true);
    }
    if(response.event==='error')throw Error(response.message);
    if(response.event!=='result')throw Error('Expected a native workspace result');
    return response.text;
   }finally{control?.removeEventListener('abort',abort);busy=false;}
  },
  async close(){fail(Error('Native workspace host closed by owner'));await closed;}
 };
}
