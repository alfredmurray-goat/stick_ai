import spawn from 'cross-spawn';
import type {ChildProcess} from 'node:child_process';
import {JSONRPCMessageSchema,type JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {killProcessTree} from '../sandbox/process.js';
/** NDJSON MCP transport with an isolated, supervised process group. */
export class McpProcessTransport implements Transport {
 onclose:(()=>void)|undefined;onerror:((error:Error)=>void)|undefined;onmessage:((message:JSONRPCMessage)=>void)|undefined;
 private child:ChildProcess|undefined;private exited:Promise<void>=Promise.resolve();private buffer=Buffer.alloc(0);private closing:Promise<void>|undefined;private notified=false;
 constructor(private executable:string,private args:string[],private env:Record<string,string>,private diagnostic:(bytes:Buffer)=>void){}
 private closed(){if(this.notified)return;this.notified=true;this.onclose?.();}
 async start(){
  if(this.child)throw Error('MCP transport already started');
  await new Promise<void>((resolve,reject)=>{
   const child=spawn(this.executable,this.args,{env:this.env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});this.child=child;this.exited=new Promise(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
   child.once('spawn',resolve);child.once('error',error=>{reject(error);this.onerror?.(error);this.closed();});child.once('close',()=>this.closed());
   child.stdin?.on('error',error=>this.onerror?.(error));child.stderr?.on('data',this.diagnostic);
   child.stdout?.on('data',(chunk:Buffer)=>{try{
    this.buffer=Buffer.concat([this.buffer,chunk]);let end:number;
    while((end=this.buffer.indexOf(10))>=0){if(end>4*1024**2)throw Error('MCP message is too large');const line=this.buffer.subarray(0,end);this.buffer=this.buffer.subarray(end+1);if(line.length)this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line))));}
    if(this.buffer.length>4*1024**2)throw Error('MCP message is too large');
   }catch(error){this.onerror?.(error instanceof Error?error:new Error('Invalid MCP response'));void this.close();}});
  });
 }
 async send(message:JSONRPCMessage){const input=this.child?.stdin;if(!input||input.destroyed)throw Error('MCP process is not connected');await new Promise<void>((resolve,reject)=>input.write(JSON.stringify(message)+'\n',error=>error?reject(error):resolve()));}
 async close(){if(this.closing)return this.closing;this.closing=(async()=>{const child=this.child;if(child?.pid)await killProcessTree(child.pid,process.platform).catch(()=>{child.kill('SIGKILL');});child?.stdin?.destroy();child?.stdout?.destroy();child?.stderr?.destroy();await this.exited;this.closed();})();return this.closing;}
}
