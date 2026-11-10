import {getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {ListToolsResultSchema,CallToolResultSchema,type Tool} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {randomUUID} from 'node:crypto';
import {join,delimiter} from 'node:path';
import {homedir} from 'node:os';
import {McpProcessTransport} from './mcp-process.js';
import {McpRpc,McpError} from './mcp-rpc.js';
import {readExtensionJson,writeExtensionJson} from './extension-store.js';
import {targetFor,executableName} from './platform.js';
export {McpError};
export interface McpServerConfig {id:string;name:string;transport:'stdio'|'http'|'sse';command?:string;args?:string[];url?:string}
interface Secrets {headers:Record<string,string>;env:Record<string,string>}
interface Connection {rpc:McpRpc;tools:Tool[];stale:boolean;diagnostic:string}
function record(value:unknown):value is Record<string,unknown>{return Boolean(value&&typeof value==='object'&&!Array.isArray(value));}
function stringMap(value:unknown):Record<string,string>{if(value===undefined)return {};if(!record(value)||Object.keys(value).length>64||Object.entries(value).some(([key,v])=>typeof v!=='string'||!key||/[\x00-\x1f]/.test(key)||String(v).includes('\0'))||Buffer.byteLength(JSON.stringify(value))>16384)throw new McpError('Enter a JSON object of string values, under 16 KiB.');return value as Record<string,string>;}
function config(input:unknown,id:string):McpServerConfig {
 if(!record(input)||typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\x00-\x1f]/.test(input.name)||!['stdio','http','sse'].includes(String(input.transport)))throw new McpError('Enter a server name and supported transport.');
 const base={id,name:input.name.trim(),transport:input.transport as McpServerConfig['transport']};
 if(base.transport==='stdio'){
  if(typeof input.command!=='string'||!input.command.trim()||input.command.length>2048||/[\x00-\x1f]/.test(input.command)||!Array.isArray(input.args)||input.args.length>100||input.args.some(a=>typeof a!=='string'||a.includes('\0'))||Buffer.byteLength(JSON.stringify(input.args))>12288)throw new McpError('Enter an executable and a JSON array of arguments (under 12 KiB).');
  return {...base,command:input.command,args:input.args as string[]};
 }
 let url:URL;try{url=new URL(String(input.url));}catch{throw new McpError('Enter a valid MCP server URL.');}
 if(url.username||url.password||url.hash||url.href.length>4096||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new McpError('Use HTTPS, or HTTP on localhost, without URL credentials or fragments.');
 return {...base,url:url.href};
}
/** Bounds JSON bodies and individual SSE events; it does not impose a tool deadline. */
export function mcpFetch(origin:string,fetcher:typeof fetch=fetch):typeof fetch {
 return (async(input:URL|RequestInfo,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);if(url.origin!==origin)throw new McpError('MCP requests cannot send credentials to another origin.');
  const response=await fetcher(url,{...init,redirect:'error'});if(!response.body)return response;
  const events=(response.headers.get('content-type')??'').includes('text/event-stream');let size=0,last=-1;
  if(!events&&Number(response.headers.get('content-length')??0)>4*1024**2){await response.body.cancel();throw new McpError('MCP response exceeds 4 MiB.');}
  const body=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
   for(const byte of chunk){if(++size>4*1024**2)throw new McpError('MCP response exceeds 4 MiB per message.');if(events&&byte!==13){if(byte===10&&last===10)size=0;last=byte;}}
   controller.enqueue(chunk);
  }}));
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 }) as typeof fetch;
}
export class McpServers {
 private configs:McpServerConfig[]=[];private secrets=new Map<string,Secrets>();private connections=new Map<string,Connection>();private errors=new Map<string,string>();private project:string;
 constructor(private root:string,project:string,private progress:(server:string,text:string)=>void=()=>{}){this.project=project;}
 async load(){const saved=await readExtensionJson(this.root,'mcp.json');if(saved===undefined)return;if(!record(saved)||saved.format!==1||!Array.isArray(saved.servers)||saved.servers.length>20)throw new McpError('Invalid saved MCP server settings.');this.configs=saved.servers.map(s=>{if(!record(s)||typeof s.id!=='string'||!/^mcp-[a-f0-9-]{36}$/.test(s.id))throw new McpError('Invalid MCP server identity.');return config(s,s.id);});}
 private async save(){await writeExtensionJson(this.root,'mcp.json',{format:1,servers:this.configs});}
 private get(id:string){const result=this.configs.find(c=>c.id===id);if(!result)throw new McpError('Choose a configured MCP server.');return result;}
 private redact(id:string,text:string){const secret=this.secrets.get(id);for(const value of [...Object.values(secret?.headers??{}),...Object.values(secret?.env??{})])for(const part of [value,value.replace(/^Bearer\s+/i,'')])if(part)text=text.replaceAll(part,'[redacted]');return text;}
 view(){return this.configs.map(c=>{const connection=this.connections.get(c.id);return {...c,status:connection?.rpc.ready&&!connection.rpc.closed?'connected':connection&&!connection.rpc.closed?'connecting':'disconnected',tools:connection?.tools.length??0,hasSessionSecrets:Boolean(Object.keys(this.secrets.get(c.id)?.headers??{}).length+Object.keys(this.secrets.get(c.id)?.env??{}).length),error:this.errors.get(c.id)??'',diagnostic:connection?.diagnostic??''};});}
 async add(input:unknown){if(this.configs.length>=20)throw new McpError('This app supports up to 20 configured MCP servers.');if(!record(input))throw new McpError('Invalid MCP settings.');const id='mcp-'+randomUUID(),next=config(input,id),secret={headers:stringMap(input.headers),env:stringMap(input.env)};this.configs.push(next);this.secrets.set(id,secret);try{await this.save();}catch(error){this.configs.pop();this.secrets.delete(id);throw error;}return id;}
 async remove(id:string){await this.disconnect(id);this.configs=this.configs.filter(c=>c.id!==id);this.secrets.delete(id);this.errors.delete(id);await this.save();}
 async setSecrets(id:string,input:unknown){this.get(id);if(!record(input))throw new McpError('Invalid secret fields.');const current=this.secrets.get(id)??{headers:{},env:{}};this.secrets.set(id,{headers:input.headers===undefined?current.headers:stringMap(input.headers),env:input.env===undefined?current.env:stringMap(input.env)});}
 async connect(id:string,signal:AbortSignal){
  const selected=this.get(id);await this.disconnect(id);this.errors.delete(id);const secret=this.secrets.get(id)??{headers:{},env:{}};let transport:Transport;
  if(selected.transport==='stdio'){
   const target=targetFor(process.platform,process.arch),bin=join(this.root,'bin',target),node=join(bin,executableName(target,true));
   const args=(selected.args??[]).map(arg=>arg.replaceAll('${project}',this.project).replaceAll('${app}',this.root));const command=selected.command==='node'?node:selected.command!;
   const spec=Buffer.from(JSON.stringify({command,args,cwd:this.project})).toString('base64'),env=getDefaultEnvironment();
   env.PATH=[bin,...(process.platform==='win32'?[join(homedir(),'AppData','Roaming','npm')]:['/opt/homebrew/bin','/usr/local/bin',join(homedir(),'.local','bin')]),env.PATH??''].join(delimiter);
   transport=new McpProcessTransport(node,[join(this.root,'app/stick-mcp.cjs'),spec],{...env,STICK_MCP_ENV_JSON:JSON.stringify(secret.env)},bytes=>{const c=this.connections.get(id);if(c)c.diagnostic=this.redact(id,(c.diagnostic+bytes.toString('utf8')).slice(-4000));});
  }else{
   const url=new URL(selected.url!);const headers=new Headers(secret.headers);for(const name of ['host','content-length','connection','proxy-authorization','cookie'])if(headers.has(name))throw new McpError('Use API authentication headers, without host, cookie, or transport headers.');
   const options={requestInit:{headers,redirect:'error' as RequestRedirect},fetch:mcpFetch(url.origin)};
   transport=selected.transport==='sse'?new SSEClientTransport(url,options):new StreamableHTTPClientTransport(url,options);
  }
  const connection:Connection={rpc:new McpRpc(transport,(method,params)=>{if(method==='notifications/tools/list_changed')connection.stale=true;if(method==='notifications/progress')this.progress(selected.name,this.redact(id,typeof params.message==='string'?params.message.slice(0,1000):typeof params.progress==='number'?`${params.progress}${typeof params.total==='number'?' / '+params.total:''}`:'Working…'));}),tools:[],stale:false,diagnostic:''};
  this.connections.set(id,connection);
  try{await connection.rpc.connect(signal);await this.refresh(id,signal);}catch(error){await connection.rpc.close();this.connections.delete(id);const message=signal.aborted?'MCP connection cancelled.':'Could not connect. Check the command, endpoint and session credentials. OAuth-only servers need a provider-issued access token.';this.errors.set(id,message);throw new McpError(message);}
 }
 async disconnect(id:string){const current=this.connections.get(id);this.connections.delete(id);if(current)await current.rpc.close();}
 async setProject(project:string){for(const c of this.configs)if(c.transport==='stdio')await this.disconnect(c.id);this.project=project;}
 async close(){await Promise.all(this.configs.map(c=>this.disconnect(c.id)));}
 private connected(id:string){const c=this.connections.get(id);if(!c?.rpc.ready||c.rpc.closed)throw new McpError('Connect this MCP server in settings first.');return c;}
 private async refresh(id:string,signal:AbortSignal){const c=this.connected(id),tools:Tool[]=[];let cursor:string|undefined;const seen=new Set<string>();do{const page=ListToolsResultSchema.parse(await c.rpc.request('tools/list',cursor?{cursor}:{},signal));for(const tool of page.tools){if(seen.has(tool.name)||tool.name.length>128||tools.length>=1000)throw new McpError('Invalid or excessive MCP tool catalog.');seen.add(tool.name);tools.push(tool);}if(page.nextCursor===cursor&&cursor)throw new McpError('MCP tool pagination did not advance.');cursor=page.nextCursor;}while(cursor);c.tools=tools;c.stale=false;}
 catalog(){return this.view().filter(c=>c.status==='connected').map(c=>({id:c.id,name:c.name,tools:c.tools}));}
 async tools(id:string,query:string,signal:AbortSignal){const c=this.connected(id);if(c.stale)await this.refresh(id,signal);return this.redact(id,JSON.stringify(c.tools.filter(t=>!query||t.name.toLowerCase().includes(query.toLowerCase())||(t.description??'').toLowerCase().includes(query.toLowerCase())).slice(0,60).map(t=>({name:t.name,description:t.description??'',inputSchema:t.inputSchema}))).slice(0,30000));}
 async call(id:string,name:string,args:unknown,signal:AbortSignal,approve:(label:string,data:unknown,signal:AbortSignal)=>Promise<boolean>){
  const c=this.connected(id);if(c.stale)await this.refresh(id,signal);const selected=this.get(id);if(!c.tools.some(t=>t.name===name)||!record(args)||Buffer.byteLength(JSON.stringify(args))>65536)throw new McpError('Choose a listed MCP tool and JSON object arguments under 64 KiB.');
  if(!await approve(`${selected.name} · ${name}`,args,signal))return 'Denied by user';signal.throwIfAborted();
  const result=CallToolResultSchema.parse(await c.rpc.request('tools/call',{name,arguments:args},signal));
  const text=result.content.map(item=>item.type==='text'?item.text:item.type==='resource'&&'text' in item.resource?item.resource.text:`[${item.type} content returned; the current model accepts text.]`).join('\n');
  return this.redact(id,(result.isError?'Error: ':'')+(text+(result.structuredContent?'\n'+JSON.stringify(result.structuredContent):'')).slice(0,30000));
 }
 async importProject(text:string){if(Buffer.byteLength(text)>65536)throw new McpError('MCP configuration exceeds 64 KiB.');let value:unknown;try{value=JSON.parse(text);}catch{throw new McpError('Enter valid .mcp.json JSON.');}if(!record(value)||!record(value.mcpServers))throw new McpError('Expected a mcpServers object.');const added=[];for(const [name,item]of Object.entries(value.mcpServers)){if(!record(item))throw new McpError('Invalid MCP server entry.');added.push(await this.add({name,transport:item.type==='sse'?'sse':item.url?'http':'stdio',command:item.command,args:item.args??[],url:item.url,headers:item.headers,env:item.env}));}return added;}
}
