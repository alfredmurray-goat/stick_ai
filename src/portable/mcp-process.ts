import {parseMcpMessage} from './mcp-wire.js';
import {McpLines} from './mcp-lines.js';
import {spawnCommand} from './spawn-command.js';
import type {ChildProcess} from 'node:child_process';
import type {JSONRPCMessage} from './mcp-types.js';
import type {Transport} from './mcp-types.js';
import {killProcessTree} from '../sandbox/process.js';
/** NDJSON MCP transport with an isolated, supervised process group. */
export class McpProcessTransport implements Transport {
 onclose:(()=>void)|undefined;onerror:((error:Error)=>void)|undefined;onmessage:((message:JSONRPCMessage)=>void)|undefined;
 private decoder=new TextDecoder('utf-8',{fatal:true});
 private child:ChildProcess|undefined;private exited:Promise<void>=Promise.resolve();private lines=new McpLines();private closing:Promise<void>|undefined;private notified=false;
 // lifeline: a fourth pipe the native Host bridge watches; closing it (or the app exiting) ends the MCP process group.
 constructor(private executable:string,private args:string[],private env:Record<string,string>,private diagnostic:(bytes:Buffer)=>void,private lifeline=false){}
 private closed(){this.lines.clear();if(this.notified)return;this.notified=true;this.onclose?.();}
 async start(){
  if(this.child)throw Error('MCP transport already started');
  await new Promise<void>((resolve,reject)=>{
   const child=spawnCommand(this.executable,this.args,{env:this.env,stdio:this.lifeline?['pipe','pipe','pipe','pipe']:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});this.child=child;this.exited=new Promise(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
   child.once('spawn',resolve);child.once('error',error=>{reject(error);this.onerror?.(error);this.closed();});child.once('close',()=>this.closed());
   child.stdin?.on('error',error=>this.onerror?.(error));child.stderr?.on('data',this.diagnostic);
   child.stdout?.on('data',(chunk:Buffer)=>{if(this.closing||this.notified)return;try{
    this.lines.push(chunk,line=>this.onmessage?.(parseMcpMessage(JSON.parse(this.decoder.decode(line)))));
   }catch(error){this.onerror?.(error instanceof Error?error:new Error('Invalid MCP response'));void this.close();}});
  });
 }
 async send(message:JSONRPCMessage){const input=this.child?.stdin;if(!input||input.destroyed)throw Error('MCP process is not connected');await new Promise<void>((resolve,reject)=>input.write(JSON.stringify(message)+'\n',error=>error?reject(error):resolve()));}
 async close(){if(this.closing)return this.closing;this.lines.clear();this.closing=(async()=>{const child=this.child;if(child?.pid)await killProcessTree(child.pid,process.platform).catch(()=>{child.kill('SIGKILL');});child?.stdin?.destroy();child?.stdout?.destroy();child?.stderr?.destroy();await this.exited;this.closed();})();return this.closing;}
}
