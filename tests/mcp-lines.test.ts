import {expect,it,vi} from 'vitest';
import {McpLines} from '../src/portable/mcp-lines.js';
import {McpRpc} from '../src/portable/mcp-rpc.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';

it('frames split UTF-8, CRLF, empty lines and multiple messages without retaining chunk tails',()=>{
 const input=Buffer.from('\n{"text":"æ 🦈"}\r\n{"value":2}\n');
 for(let split=0;split<=input.length;split++){
  const reader=new McpLines(),messages:unknown[]=[];
  const consume=(line:Buffer)=>messages.push(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)));
  reader.push(input.subarray(0,split),consume);reader.push(input.subarray(split),consume);
  expect(messages).toEqual([{text:'æ 🦈'},{value:2}]);expect(reader.bufferedBytes).toBe(0);expect(reader.capacityBytes).toBeLessThanOrEqual(4096);
 }
});

it('copies fragmented large messages linearly and releases large framing buffers',()=>{
 const reader=new McpLines(),size=256*1024,chunk=Buffer.alloc(64,120);
 const original=Buffer.prototype.copy;let copied=0,length=0;
 const spy=vi.spyOn(Buffer.prototype,'copy').mockImplementation(function(this:Buffer,...args:Parameters<Buffer['copy']>){const count=original.apply(this,args);copied+=count;return count;});
 try{
  for(let bytes=0;bytes<size;bytes+=chunk.length)reader.push(chunk,()=>{throw Error('Unexpected line');});
  expect(reader.bufferedBytes).toBe(size);expect(reader.capacityBytes).toBeLessThanOrEqual(size);
  reader.push(Buffer.from('\n'),line=>{length=line.length;});
 }finally{spy.mockRestore();}
 expect(length).toBe(size);expect(copied).toBeLessThan(3*size);expect(reader.capacityBytes).toBe(0);
});

it('accepts the exact line limit, rejects overlong fragments and clears partial input',()=>{
 const reader=new McpLines(),limit=4*1024**2;let received=0;
 reader.push(Buffer.alloc(limit,120),()=>{});reader.push(Buffer.from('\n'),line=>{received=line.length;});
 expect(received).toBe(limit);expect(reader.capacityBytes).toBe(0);
 reader.push(Buffer.alloc(limit,120),()=>{});expect(()=>reader.push(Buffer.from('x'),()=>{})).toThrow('too large');
 reader.clear();expect(reader.bufferedBytes).toBe(0);expect(reader.capacityBytes).toBe(0);
 expect(()=>reader.push(Buffer.alloc(limit+1,120),()=>{})).toThrow('too large');
});

it('bounds pending RPC calls and releases capacity after replies and close',async()=>{
 const sent:unknown[]=[];const transport:Transport={start:async()=>{},close:vi.fn(async()=>{}),send:async message=>{sent.push(message);}};
 const rpc=new McpRpc(transport),calls:Promise<unknown>[]=[];
 for(let i=0;i<64;i++)calls.push(rpc.request('tools/list',{},new AbortController().signal));
 const all=Promise.allSettled(calls);
 await expect(rpc.request('tools/list',{},new AbortController().signal)).rejects.toThrow('Too many');expect(sent).toHaveLength(64);
 transport.onmessage?.({jsonrpc:'2.0',id:1,result:{tools:[]}});await expect(calls[0]).resolves.toEqual({tools:[]});
 const replacement=rpc.request('tools/list',{},new AbortController().signal);const replacementResult=Promise.allSettled([replacement]);
 expect(sent).toHaveLength(65);await rpc.close();const results=await all;
 expect(results.filter(value=>value.status==='rejected')).toHaveLength(63);expect((await replacementResult)[0]?.status).toBe('rejected');
 expect(transport.close).toHaveBeenCalledOnce();
});

it('bounds aggregate outgoing bytes and recovers budget after replies and send failures',async()=>{
 let fail=false;const sent:unknown[]=[];
 const transport:Transport={start:async()=>{},close:async()=>{},send:message=>{if(fail)throw Error('Send failed');sent.push(message);return Promise.resolve();}};
 const rpc=new McpRpc(transport),params={text:'x'.repeat(2200000)},signal=new AbortController().signal;
 const first=rpc.request('tools/call',params,signal);
 await expect(rpc.request('tools/call',params,signal)).rejects.toThrow('in-flight budget');expect(sent).toHaveLength(1);
 transport.onmessage?.({jsonrpc:'2.0',id:1,result:{content:[]}});await first;
 fail=true;await expect(rpc.request('tools/call',params,signal)).rejects.toThrow('Could not send');
 fail=false;const next=rpc.request('tools/call',params,signal),result=Promise.allSettled([next]);
 expect(sent).toHaveLength(2);await rpc.close();expect((await result)[0]?.status).toBe('rejected');
});
