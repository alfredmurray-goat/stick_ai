import {McpLines} from './mcp-lines.js';
import {parseMcpMessage} from './mcp-wire.js';
import type {JSONRPCMessage,Transport,RpcId} from './mcp-types.js';

const limit=4*1024**2;
interface Event {event:string;data:string;id?:string;retry?:number}
/** SSE framing, including CR, LF, CRLF, split UTF-8 and multiline data. */
export class McpEvents {
 private lines=new McpLines(true);private skipLf=false;private bytes=0;private data:string[]=[];private kind='message';private id:string|undefined;private retry:number|undefined;private first=true;
 push(chunk:Uint8Array,consume:(event:Event)=>void){
  const normalized=Buffer.allocUnsafe(chunk.length);let length=0;
  for(const b of chunk){if(this.skipLf&&b===10){this.skipLf=false;continue;}this.skipLf=b===13;normalized[length++]=b===13?10:b;}
  this.lines.push(normalized.subarray(0,length),raw=>{
   this.bytes+=raw.length+1;if(this.bytes>limit)throw Error('Stellan-Link SSE event exceeds 4 MiB');
   let line=new TextDecoder('utf-8',{fatal:true}).decode(raw);if(this.first){line=line.replace(/^\uFEFF/,'');this.first=false;}
   if(!line){consume({event:this.kind,data:this.data.join('\n'),...(this.id!==undefined?{id:this.id}:{}),...(this.retry!==undefined?{retry:this.retry}:{})});this.data=[];this.kind='message';this.bytes=0;return;}
   if(line.startsWith(':'))return;const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon);let value=colon<0?'':line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
   if(field==='data')this.data.push(value);else if(field==='event')this.kind=value||'message';else if(field==='id'&&!value.includes('\0'))this.id=value;
   else if(field==='retry'&&/^\d+$/.test(value)){const ms=Number(value);if(!Number.isSafeInteger(ms)||ms>2147483647)throw Error('Invalid SSE retry interval');this.retry=ms;}
  });
 }
}
function isRequest(message:JSONRPCMessage):message is JSONRPCMessage&{id:RpcId;method:string}{return 'method'in message&&message.id!==undefined;}
export class McpHttpTransport implements Transport {
 onmessage?:Transport['onmessage'];onerror?:Transport['onerror'];onclose?:Transport['onclose'];
 private control=new AbortController();private started=false;private ended=false;private version:string|undefined;private session:string|undefined;private endpoint:URL|undefined;private listener:Promise<void>|undefined;private listening=false;
 constructor(private url:URL,private mode:'http'|'sse',private auth:Headers=new Headers(),private fetcher:typeof fetch=fetch){}
 setProtocolVersion(version:string){this.version=version;}
 private headers(accept:string){const h=new Headers(this.auth);h.set('Accept',accept);if(this.version)h.set('MCP-Protocol-Version',this.version);if(this.session)h.set('MCP-Session-Id',this.session);return h;}
 private async request(url:URL,init:RequestInit){
  if(url.origin!==this.url.origin||url.username||url.password||url.hash)throw Error('Stellan-Link refuses cross-origin credentials');
  const r=await this.fetcher(url,{...init,redirect:'error',signal:this.control.signal});
  if(!r.ok){await r.body?.cancel();throw Error(r.status===404&&this.session?'MCP session expired. Reconnect the server.':`MCP HTTP ${r.status}`);}
  return r;
 }
 private async json(response:Response){
  if(!response.body)throw Error('Missing MCP response');const reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>limit)throw Error('MCP response exceeds 4 MiB');parts.push(p.value);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 private async events(response:Response,consume:(e:Event)=>boolean|void){
  if(!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')||!response.body){await response.body?.cancel();throw Error('Expected an MCP event stream');}
  const reader=response.body.getReader(),parser=new McpEvents();let stop=false;let lastId:string|undefined,retry=1000;
  try{while(!stop){let p:ReadableStreamReadResult<Uint8Array>;try{p=await reader.read();}catch(error){if(this.control.signal.aborted||!lastId)throw error;break;}if(p.done)break;parser.push(p.value,e=>{if(stop)return;if(e.id!==undefined)lastId=e.id;if(e.retry!==undefined)retry=e.retry;if(consume(e)===false)stop=true;});}return {lastId,retry};}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 private message(e:Event){if(e.event==='message'&&e.data)this.onmessage?.(parseMcpMessage(JSON.parse(e.data)));}
 private fail(error:unknown){if(this.ended)return;this.onerror?.(error instanceof Error?error:new Error('MCP transport failed'));void this.close();}
 async start(){
  if(this.started||this.ended)throw Error('MCP transport already started or closed');this.started=true;
  if(this.mode==='http')return;
  let accept!:()=>void,reject!:(error:unknown)=>void;const endpoint=new Promise<void>((a,b)=>{accept=a;reject=b;});
  this.listener=(async()=>{
   try{const response=await this.request(this.url,{method:'GET',headers:this.headers('text/event-stream')});
    await this.events(response,e=>{if(e.event==='endpoint'){
     if(this.endpoint)throw Error('Duplicate MCP SSE endpoint');const url=new URL(e.data,this.url);if(url.origin!==this.url.origin||url.username||url.password||url.hash)throw Error('Unsafe MCP SSE endpoint');this.endpoint=url;accept();
    }else if(e.data){if(!this.endpoint)throw Error('MCP message preceded its endpoint');this.message(e);}});
    if(!this.ended)throw Error('MCP SSE connection ended. Reconnect the server.');
   }catch(error){reject(error);this.fail(error);}
  })();
  const abort=()=>reject(this.control.signal.reason);this.control.signal.addEventListener('abort',abort,{once:true});
  try{await endpoint;}finally{this.control.signal.removeEventListener('abort',abort);}
 }
 private async pause(ms:number){await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(this.control.signal.reason);};const timer=setTimeout(()=>{this.control.signal.removeEventListener('abort',abort);resolve();},ms);this.control.signal.addEventListener('abort',abort,{once:true});if(this.control.signal.aborted)abort();});}
 private notifications(){
  if(this.listening||this.mode!=='http')return;this.listening=true;
  this.listener=(async()=>{
   try{let id:string|undefined;
    while(!this.ended){
     const h=this.headers('text/event-stream');if(id)h.set('Last-Event-ID',id);
     const response=await this.fetcher(this.url,{method:'GET',headers:h,redirect:'error',signal:this.control.signal});
     if(response.status===405){await response.body?.cancel();return;}if(!response.ok){await response.body?.cancel();throw Error('MCP notification stream failed');}
     const state=await this.events(response,e=>this.message(e));id=state.lastId??id;if(!this.ended)await this.pause(Math.max(50,state.retry));
    }

   }catch(error){this.fail(error);}
  })();
 }
 async send(message:JSONRPCMessage){try{await this.sendMessage(message);}catch(error){this.fail(error);throw error;}}
 private async sendMessage(message:JSONRPCMessage){
  if(!this.started||this.ended)throw Error('MCP transport is not connected');
  const headers=this.headers('application/json, text/event-stream');headers.set('Content-Type','application/json');
  const request=isRequest(message);const initialize=request&&message.method==='initialize';
  const response=await this.request(this.endpoint??this.url,{method:'POST',headers,body:JSON.stringify(message)});
  if(initialize){const id=response.headers.get('MCP-Session-Id');if(id!==null){if(!/^[\x21-\x7e]{1,4096}$/.test(id)){await response.body?.cancel();throw Error('Invalid MCP session identity');}this.session=id;}}
  if(!request||this.mode==='sse'){await response.body?.cancel();if(response.status!==202&&response.status!==204)throw Error('Expected MCP acknowledgement');if('method'in message&&message.method==='notifications/initialized')this.notifications();return;}
  const type=response.headers.get('content-type')?.toLowerCase()??'';
  let matched=false;
  const deliver=(input:unknown)=>{const value=parseMcpMessage(input);if(!('method'in value)&&value.id===message.id)matched=true;this.onmessage?.(value);};
  if(type.startsWith('application/json')){deliver(await this.json(response));if(!matched)throw Error('MCP response ID did not match its request');return;}
  let state=await this.events(response,e=>{if(e.event==='message'&&e.data)deliver(JSON.parse(e.data));if(matched)return false;});
  while(!matched){
   if(!state.lastId)throw Error('MCP stream disconnected without a resume cursor');await this.pause(Math.max(50,state.retry));
   const h=this.headers('text/event-stream');h.set('Last-Event-ID',state.lastId);
   const resumed=await this.request(this.url,{method:'GET',headers:h});
   const next=await this.events(resumed,e=>{if(e.event==='message'&&e.data)deliver(JSON.parse(e.data));if(matched)return false;});state={...next,lastId:next.lastId??state.lastId};
  }
  if(!matched)throw Error('MCP response stream disconnected repeatedly. Reconnect the server.');
 }
 async close(){
  if(this.ended)return;this.ended=true;this.control.abort(new Error('MCP transport closed'));this.onclose?.();await this.listener;
  // Do not keep shutdown waiting on an unresponsive remote session terminator.
  if(this.session&&this.mode==='http')try{const r=await this.fetcher(this.url,{method:'DELETE',headers:this.headers('application/json'),redirect:'error',signal:AbortSignal.timeout(2000)});await r.body?.cancel();}catch{}
 }
}
