import {expect,it,vi} from 'vitest';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {McpRpc} from '../src/portable/mcp-rpc.js';

it('closes a server flooding stalled ping replies and ignores messages after close',async()=>{
 const writes:Array<()=>void>=[];
 const transport:Transport={start:async()=>{},close:vi.fn(async()=>{}),send:vi.fn(message=>'method'in message?Promise.resolve():new Promise<void>(resolve=>writes.push(resolve)))};
 const rpc=new McpRpc(transport);
 const pending=expect(rpc.request('tools/list',{},new AbortController().signal)).rejects.toThrow('closed');
 for(let id=0;id<40;id++)transport.onmessage?.({jsonrpc:'2.0',id:'server-'+id,method:'ping'});
 await pending;
 expect(rpc.closed).toBe(true);expect(writes).toHaveLength(16);expect(transport.send).toHaveBeenCalledTimes(17);
 for(const release of writes)release();await rpc.close();
 expect(transport.close).toHaveBeenCalledOnce();
});

it('shares the outgoing byte budget with server replies instead of echoing oversized IDs',async()=>{
 const transport:Transport={start:async()=>{},close:vi.fn(async()=>{}),send:vi.fn(async()=>{})};
 const rpc=new McpRpc(transport);
 const pending=expect(rpc.request('tools/call',{text:'x'.repeat(3*1024**2)},new AbortController().signal)).rejects.toThrow('closed');
 transport.onmessage?.({jsonrpc:'2.0',id:'y'.repeat(2*1024**2),method:'ping'});
 await pending;await rpc.close();
 expect(transport.send).toHaveBeenCalledTimes(1);expect(transport.close).toHaveBeenCalledOnce();
});

it('releases settled server replies so ordinary calls can keep using the connection',async()=>{
 const transport:Transport={start:async()=>{},close:async()=>{},send:vi.fn(async()=>{})};
 const rpc=new McpRpc(transport);
 for(let i=0;i<25;i++){transport.onmessage?.({jsonrpc:'2.0',id:'ping-'+i,method:'ping'});await Promise.resolve();}
 expect(rpc.closed).toBe(false);expect(transport.send).toHaveBeenCalledTimes(25);
 const call=rpc.request('tools/list',{},new AbortController().signal);
 transport.onmessage?.({jsonrpc:'2.0',id:1,result:{tools:[]}});await expect(call).resolves.toEqual({tools:[]});await rpc.close();
});
