import {expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {LATEST_PROTOCOL_VERSION,SUPPORTED_PROTOCOL_VERSIONS,InitializeResultSchema} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {McpRpc} from '../src/portable/mcp-rpc.js';
import {parseMcpInitialization,MCP_PROTOCOL_VERSION,MCP_PROTOCOL_VERSIONS} from '../src/portable/mcp-handshake.js';

it('keeps negotiated versions explicit and validates supported tool-client handshake fields',()=>{
 expect(MCP_PROTOCOL_VERSION).toBe(LATEST_PROTOCOL_VERSION);expect(MCP_PROTOCOL_VERSIONS).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
 const input={protocolVersion:MCP_PROTOCOL_VERSION,serverInfo:{name:'fixture',version:'1',title:'Unicode æ 🦈'},capabilities:{tools:{listChanged:true},resources:{subscribe:true}},instructions:'Server guidance is not automatically trusted.'};
 expect(InitializeResultSchema.safeParse(input).success).toBe(true);
 expect(parseMcpInitialization(input)).toEqual({protocolVersion:MCP_PROTOCOL_VERSION,serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{listChanged:true}}});
 for(const value of [{...input,serverInfo:{}},{...input,capabilities:{tools:true}},{...input,capabilities:{tools:{listChanged:'yes'}}},{...input,protocolVersion:1},{...input,instructions:{}},{...input,serverInfo:{name:'x',version:1}}])expect(()=>parseMcpInitialization(value)).toThrow();
});

it('completes the real RPC handshake and closes unsupported or tool-less sessions',async()=>{
 for(const mode of ['valid','unsupported','no-tools']){
  const sent:unknown[]=[];
  const transport:Transport={start:async()=>{},close:vi.fn(async()=>{}),setProtocolVersion:vi.fn(),send:async message=>{
   sent.push(message);
   if('method'in message&&message.method==='initialize'&&'id'in message)queueMicrotask(()=>transport.onmessage?.({jsonrpc:'2.0',id:message.id,result:{protocolVersion:mode==='unsupported'?'unsupported':MCP_PROTOCOL_VERSION,serverInfo:{name:'fixture',version:'1'},capabilities:mode==='no-tools'?{}:{tools:{}}}}));
  }};
  const rpc=new McpRpc(transport);
  if(mode==='valid'){
   await rpc.connect(new AbortController().signal);expect(rpc.ready).toBe(true);expect(transport.setProtocolVersion).toHaveBeenCalledWith(MCP_PROTOCOL_VERSION);expect(sent).toContainEqual({jsonrpc:'2.0',method:'notifications/initialized'});await rpc.close();
  }else {await expect(rpc.connect(new AbortController().signal)).rejects.toThrow();expect(transport.close).toHaveBeenCalledOnce();expect(rpc.ready).toBe(false);}
 }
});

it('bundles the original RPC core without an SDK or schema-runtime implementation',async()=>{
 const result=await build({entryPoints:['src/portable/mcp-rpc.ts'],bundle:true,platform:'node',format:'esm',write:false,metafile:true});
 expect(Object.keys(result.metafile!.inputs).some(path=>path.includes('node_modules/'))).toBe(false);
 expect(result.outputFiles).toHaveLength(1);
});


it('settles stalled startup on disconnect and ignores a late start completion',async()=>{
 let complete!:()=>void;
 const transport:Transport={start:()=>new Promise<void>(resolve=>{complete=resolve;}),send:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
 const rpc=new McpRpc(transport),pending=rpc.connect(new AbortController().signal);const result=expect(pending).rejects.toThrow('closed');
 await rpc.close();await result;complete();await Promise.resolve();
 expect(rpc.ready).toBe(false);expect(transport.send).not.toHaveBeenCalled();expect(transport.close).toHaveBeenCalledOnce();
});
