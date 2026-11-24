import {parseMcpMessage} from './mcp-wire.js';
import type {Transport} from './mcp-types.js';
import type {JSONRPCMessage} from './mcp-types.js';
import {parseMcpInitialization,MCP_PROTOCOL_VERSION,MCP_PROTOCOL_VERSIONS} from './mcp-handshake.js';
export class McpError extends Error {constructor(message:string){super(message);this.name='McpError';}}
/** MCP request lifecycle without an artificial tool-call deadline. Stop closes the transport. */
export class McpRpc {
 private connecting=false;private stopped=new AbortController();private responding=0;
 private next=0;private writing=0;private pendingBytes=0;private pending=new Map<number,{resolve(value:unknown):void;reject(error:unknown):void;cleanup():void}>();closed=false;ready=false;private closing:Promise<void>|undefined;
 constructor(private transport:Transport,private notification:(method:string,params:Record<string,unknown>)=>void=()=>{}) {
  transport.onmessage=message=>{void this.receive(message).catch(()=>this.close());};
  transport.onclose=()=>this.finish(new McpError('The MCP server disconnected. Reconnect it in settings.'));
  transport.onerror=()=>{void this.close();};
 }
 private finish(error:Error){this.closed=true;this.ready=false;this.stopped.abort(error);for(const entry of this.pending.values()){entry.cleanup();entry.reject(error);}this.pending.clear();}
 private async receive(input:JSONRPCMessage){
  if(this.closed)return;
  const message=parseMcpMessage(input);
  if('method' in message){
   if('id' in message){
    const reply:JSONRPCMessage=message.method==='ping'?{jsonrpc:'2.0',id:message.id,result:{}}:{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'This client does not enable sampling or elicitation.'}};
    const bytes=Buffer.byteLength(JSON.stringify(reply));
    // A server must not turn slow transport writes into an unbounded reply queue.
    if(this.responding>=16||bytes>4*1024**2-this.pendingBytes){await this.close();return;}
    ++this.responding;this.pendingBytes+=bytes;
    try{await this.transport.send(reply);}finally{--this.responding;this.pendingBytes-=bytes;}
   }
   else this.notification(message.method,(message.params??{}) as Record<string,unknown>);
   return;
  }
  const entry=typeof message.id==='number'?this.pending.get(message.id):undefined;if(!entry)return;this.pending.delete(message.id as number);entry.cleanup();
  if('error' in message)entry.reject(new McpError('MCP server request failed. Check its configuration and tool arguments.'));else entry.resolve(message.result);
 }
 private wait<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
   const cleanup=()=>signal.removeEventListener('abort',cancel);
   const cancel=()=>{cleanup();reject(signal.reason);};
   signal.addEventListener('abort',cancel,{once:true});
   work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
   if(signal.aborted)cancel();
  });
 }
 async connect(signal:AbortSignal){
  signal.throwIfAborted();if(this.closed||this.ready||this.connecting)throw new McpError('This MCP connection is already started or closed. Reconnect it in settings.');
  this.connecting=true;const control=AbortSignal.any([signal,this.stopped.signal]),abort=()=>{void this.close();};signal.addEventListener('abort',abort,{once:true});
  try{
   await this.wait(this.transport.start(),control);control.throwIfAborted();
   const initialized=parseMcpInitialization(await this.request('initialize',{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'stick-ai',version:'0.2.0'}},control));
   if(!MCP_PROTOCOL_VERSIONS.includes(initialized.protocolVersion))throw new McpError('This MCP protocol version is unsupported.');
   this.transport.setProtocolVersion?.(initialized.protocolVersion);
   if(!initialized.capabilities.tools)throw new McpError('This server does not provide MCP tools.');
   await this.wait(this.transport.send({jsonrpc:'2.0',method:'notifications/initialized'}),control);control.throwIfAborted();this.ready=true;
  }catch(error){await this.close();throw signal.aborted?signal.reason:error;}finally{this.connecting=false;signal.removeEventListener('abort',abort);}
 }

 request(method:string,params:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
  signal.throwIfAborted();if(this.closed)return Promise.reject(new McpError('Connect this MCP server first.'));
  if(this.pending.size>=64||this.writing>=64)return Promise.reject(new McpError('Too many MCP requests are waiting. Wait for a response or reconnect the server.'));
  const id=this.next+1,message=parseMcpMessage({jsonrpc:'2.0',id,method,params:{...params,_meta:{progressToken:String(id)}}});
  const bytes=Buffer.byteLength(JSON.stringify(message));
  if(bytes>4*1024**2-this.pendingBytes)return Promise.reject(new McpError('MCP requests exceed the 4 MiB in-flight budget. Wait for a response or reconnect the server.'));
  this.next=id;++this.writing;this.pendingBytes+=bytes;
  return new Promise((resolve,reject)=>{
   let released=false,responseSettled=false,writeSettled=false;
   const release=()=>{if(!released&&responseSettled&&writeSettled){released=true;this.pendingBytes-=bytes;}};
   const cleanup=()=>{signal.removeEventListener('abort',cancel);responseSettled=true;release();};
   const cancel=()=>{this.pending.delete(id);cleanup();reject(signal.reason);try{void this.transport.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason:'Cancelled by user'}}).catch(()=>{});}catch{}void this.close();};
   this.pending.set(id,{resolve,reject,cleanup});signal.addEventListener('abort',cancel,{once:true});
   if(signal.aborted){--this.writing;writeSettled=true;cancel();return;}
   const failed=()=>{const entry=this.pending.get(id);if(entry){this.pending.delete(id);entry.cleanup();entry.reject(new McpError('Could not send the MCP request. Reconnect the server.'));}};
   const written=()=>{--this.writing;writeSettled=true;release();};
   try{void this.transport.send(message).then(written,()=>{written();failed();});}catch{written();failed();}
  });
 }
 async close(){if(this.closing)return this.closing;this.finish(new McpError('MCP connection closed.'));this.closing=Promise.resolve().then(()=>this.transport.close()).catch(()=>{});return this.closing;}
}
