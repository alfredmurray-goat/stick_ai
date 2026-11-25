import {spawn,type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {McpError} from './mcp-rpc.js';

/**
 * McpRpc's interface backed by `stellan-host --mcp-client`: Host starts the MCP program, frames and checks every
 * message, answers pings, keeps the request budget and matches replies (src/mcp_client.cpp). The app sends simple
 * commands and still runs approvals, hooks and result checks itself.
 */
export class HostMcpRpc {
 closed=false;ready=false;
 private child:ChildProcess|undefined;private next=0;private connecting=false;private closing:Promise<void>|undefined;
 private waiting=new Map<number,{resolve(value:unknown):void;reject(error:unknown):void}>();private exited:Promise<void>=Promise.resolve();
 constructor(private host:string,private args:string[],private env:Record<string,string>,private diagnostic:(bytes:Buffer)=>void,private notification:(method:string,params:Record<string,unknown>)=>void=()=>{}){}
 private start(){
  const child=spawn(this.host,this.args,{env:this.env,stdio:['pipe','pipe','pipe','pipe'],windowsHide:true});this.child=child;
  this.exited=new Promise(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
  child.stderr?.on('data',this.diagnostic);child.stdin?.on('error',()=>{});
  child.once('error',()=>this.finish(new McpError('The MCP server disconnected. Reconnect it in settings.')));
  child.once('close',()=>this.finish(new McpError('The MCP server disconnected. Reconnect it in settings.')));
  createInterface({input:child.stdout!}).on('line',line=>{
   let event:Record<string,unknown>;try{event=JSON.parse(line);}catch{void this.close();return;}
   if(event.event==='notification'){this.notification(String(event.method),(event.params??{}) as Record<string,unknown>);return;}
   if(event.event==='closed'){this.finish(new McpError(String(event.message)));return;}
   const entry=typeof event.id==='number'?this.waiting.get(event.id):undefined;if(!entry)return;this.waiting.delete(event.id as number);
   if('error' in event)entry.reject(new McpError(String(event.error)));else entry.resolve(event.result);
  });
 }
 private finish(error:Error){if(this.closed&&!this.waiting.size)return;this.closed=true;this.ready=false;for(const entry of this.waiting.values())entry.reject(error);this.waiting.clear();}
 private command(op:string,extra:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
  const id=++this.next;
  return new Promise((resolve,reject)=>{
   const cancel=()=>{this.waiting.delete(id);reject(signal.reason);try{this.child?.stdin?.write(JSON.stringify({id,op:'cancel'})+'\n');}catch{}void this.close();};
   this.waiting.set(id,{resolve:value=>{signal.removeEventListener('abort',cancel);resolve(value);},reject:error=>{signal.removeEventListener('abort',cancel);reject(error);}});
   signal.addEventListener('abort',cancel,{once:true});
   this.child!.stdin!.write(JSON.stringify({id,op,...extra})+'\n');
  });
 }
 async connect(signal:AbortSignal){
  signal.throwIfAborted();if(this.closed||this.ready||this.connecting)throw new McpError('This MCP connection is already started or closed. Reconnect it in settings.');
  this.connecting=true;
  try{this.start();await this.command('connect',{},signal);this.ready=true;}
  catch(error){await this.close();throw signal.aborted?signal.reason:error;}finally{this.connecting=false;}
 }
 request(method:string,params:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
  signal.throwIfAborted();if(this.closed||!this.child)return Promise.reject(new McpError('Connect this MCP server first.'));
  return this.command('request',{method,params},signal);
 }
 async close(){
  if(this.closing)return this.closing;this.finish(new McpError('MCP connection closed.'));
  this.closing=(async()=>{const child=this.child;if(child){try{child.stdin?.write(JSON.stringify({op:'close'})+'\n');}catch{}(child.stdio[3] as NodeJS.WritableStream|undefined)?.end?.();setTimeout(()=>child.kill('SIGKILL'),2000).unref();await this.exited;}})();
  return this.closing;
 }
}
