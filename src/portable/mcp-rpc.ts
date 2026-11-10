import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {InitializeResultSchema,LATEST_PROTOCOL_VERSION,SUPPORTED_PROTOCOL_VERSIONS,JSONRPCMessageSchema,type JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
export class McpError extends Error {constructor(message:string){super(message);this.name='McpError';}}
/** MCP request lifecycle without an artificial tool-call deadline. Stop closes the transport. */
export class McpRpc {
 private next=0;private pending=new Map<number,{resolve(value:unknown):void;reject(error:unknown):void;cleanup():void}>();closed=false;ready=false;private closing:Promise<void>|undefined;
 constructor(private transport:Transport,private notification:(method:string,params:Record<string,unknown>)=>void=()=>{}) {
  transport.onmessage=message=>{void this.receive(message).catch(()=>this.close());};
  transport.onclose=()=>this.finish(new McpError('The MCP server disconnected. Reconnect it in settings.'));
  transport.onerror=()=>{void this.close();};
 }
 private finish(error:Error){this.closed=true;this.ready=false;for(const entry of this.pending.values()){entry.cleanup();entry.reject(error);}this.pending.clear();}
 private async receive(input:JSONRPCMessage){
  const message=JSONRPCMessageSchema.parse(input);
  if('method' in message){
   if('id' in message){await this.transport.send(message.method==='ping'?{jsonrpc:'2.0',id:message.id,result:{}}:{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'This client does not enable sampling or elicitation.'}});}
   else this.notification(message.method,(message.params??{}) as Record<string,unknown>);
   return;
  }
  const entry=typeof message.id==='number'?this.pending.get(message.id):undefined;if(!entry)return;this.pending.delete(message.id as number);entry.cleanup();
  if('error' in message)entry.reject(new McpError('MCP server request failed. Check its configuration and tool arguments.'));else entry.resolve(message.result);
 }
 async connect(signal:AbortSignal){
  signal.throwIfAborted();const abort=()=>{void this.close();};signal.addEventListener('abort',abort,{once:true});
  try{await new Promise<void>((resolve,reject)=>{const cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});void this.transport.start().then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel));if(signal.aborted)cancel();});signal.throwIfAborted();const initialized=InitializeResultSchema.parse(await this.request('initialize',{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'stick-ai',version:'0.1.0'}},signal));
   if(!SUPPORTED_PROTOCOL_VERSIONS.includes(initialized.protocolVersion))throw new McpError('This MCP protocol version is unsupported.');
   this.transport.setProtocolVersion?.(initialized.protocolVersion);
   if(!initialized.capabilities.tools)throw new McpError('This server does not provide MCP tools.');
   await this.transport.send({jsonrpc:'2.0',method:'notifications/initialized'});this.ready=true;
  }catch(error){await this.close();throw signal.aborted?signal.reason:error;}finally{signal.removeEventListener('abort',abort);}
 }
 request(method:string,params:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
  signal.throwIfAborted();if(this.closed)return Promise.reject(new McpError('Connect this MCP server first.'));
  const id=++this.next;
  return new Promise((resolve,reject)=>{
   const cancel=()=>{this.pending.delete(id);signal.removeEventListener('abort',cancel);reject(signal.reason);void this.transport.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason:'Cancelled by user'}}).catch(()=>{});void this.close();};
   const cleanup=()=>signal.removeEventListener('abort',cancel);this.pending.set(id,{resolve,reject,cleanup});signal.addEventListener('abort',cancel,{once:true});
   if(signal.aborted){cancel();return;}
   void this.transport.send({jsonrpc:'2.0',id,method,params:{...params,_meta:{progressToken:String(id)}}}).catch(()=>{const entry=this.pending.get(id);if(entry){this.pending.delete(id);entry.cleanup();entry.reject(new McpError('Could not send the MCP request. Reconnect the server.'));}});
  });
 }
 async close(){if(this.closing)return this.closing;this.finish(new McpError('MCP connection closed.'));this.closing=this.transport.close().catch(()=>{});return this.closing;}
}
