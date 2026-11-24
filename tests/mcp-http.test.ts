import {expect,it} from 'vitest';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {McpEvents,McpHttpTransport} from '../src/portable/mcp-http.js';
import {McpRpc} from '../src/portable/mcp-rpc.js';
import {mcpFetch} from '../src/portable/mcp.js';
async function serve(handle:(req:IncomingMessage,res:ServerResponse)=>void|Promise<void>){
 const errors:unknown[]=[];const server=createServer((q,s)=>{void Promise.resolve(handle(q,s)).catch(e=>{errors.push(e);s.destroy();});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error();
 return {url:new URL('http://127.0.0.1:'+address.port+'/mcp'),errors,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));expect(errors).toEqual([]);}};
}
async function body(req:IncomingMessage){const chunks=[];for await(const p of req)chunks.push(p);return JSON.parse(Buffer.concat(chunks).toString());}
const init={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
for(const responseType of ['json','sse'])it('connects and calls over original HTTP '+responseType+' with negotiated session headers',async()=>{
 let deleted=false;const fixture=await serve(async(q,s)=>{
  expect(q.headers.authorization).toBe('Bearer private');
  if(q.method==='GET'){s.writeHead(405);s.end();return;}
  if(q.method==='DELETE'){deleted=true;s.writeHead(204);s.end();return;}
  const m=await body(q);
  if(m.method!=='initialize'){expect(q.headers['mcp-session-id']).toBe('session-123');expect(q.headers['mcp-protocol-version']).toBe('2025-11-25');}
  if(m.id===undefined){s.writeHead(202);s.end();return;}
  const result=m.method==='initialize'?init:m.method==='tools/list'?{tools:[]}:{content:[{type:'text',text:'real tool reply'}]};
  if(m.method==='initialize')s.setHeader('MCP-Session-Id','session-123');
  s.setHeader('Content-Type',responseType==='json'?'application/json':'text/event-stream');const message=JSON.stringify({jsonrpc:'2.0',id:m.id,result});s.end(responseType==='json'?message:'data: '+message+'\n\n');
 });
 const transport=new McpHttpTransport(fixture.url,'http',new Headers({Authorization:'Bearer private'}),mcpFetch(fixture.url.origin));const rpc=new McpRpc(transport);
 try{await rpc.connect(new AbortController().signal);expect(await rpc.request('tools/call',{},new AbortController().signal)).toEqual({content:[{type:'text',text:'real tool reply'}]});}finally{await rpc.close();await fixture.close();}
 expect(deleted).toBe(true);
});
it('uses legacy SSE endpoint events and POST acknowledgements',async()=>{
 let stream:ServerResponse|undefined;
 const fixture=await serve(async(q,s)=>{
  if(q.method==='GET'){stream=s;s.writeHead(200,{'Content-Type':'text/event-stream'});s.write('event: endpoint\ndata: /messages?session=legacy\n\n');return;}
  expect(q.url).toBe('/messages?session=legacy');const m=await body(q);s.writeHead(202);s.end();if(m.id!==undefined)stream!.write('data: '+JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?init:{tools:[]}})+'\n\n');
 });const rpc=new McpRpc(new McpHttpTransport(fixture.url,'sse',new Headers(),mcpFetch(fixture.url.origin)));
 try{await rpc.connect(new AbortController().signal);expect(await rpc.request('tools/list',{},new AbortController().signal)).toEqual({tools:[]});}finally{await rpc.close();await fixture.close();}
});
it('rejects a legacy endpoint on another origin without forwarding credentials',async()=>{
 const fixture=await serve((_q,s)=>{s.writeHead(200,{'Content-Type':'text/event-stream'});s.end('event: endpoint\ndata: https://attacker.invalid/messages\n\n');});
 const transport=new McpHttpTransport(fixture.url,'sse',new Headers({Authorization:'private'}),mcpFetch(fixture.url.origin));
 try{await expect(transport.start()).rejects.toThrow('Unsafe');}finally{await transport.close();await fixture.close();}
});
it('resumes a disconnected request by cursor without replaying the POST',async()=>{
 let posts=0,gets=0;const fixture=await serve(async(q,s)=>{
  if(q.method==='POST'){posts++;const m=await body(q);s.writeHead(200,{'Content-Type':'text/event-stream'});s.end('id: cursor-1\nretry: 0\ndata: \n\n');expect(m.id).toBe(7);}
  else {gets++;expect(q.headers['last-event-id']).toBe('cursor-1');s.writeHead(200,{'Content-Type':'text/event-stream'});s.end('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n');}
 });const transport=new McpHttpTransport(fixture.url,'http');const messages:unknown[]=[];transport.onmessage=m=>messages.push(m);
 try{await transport.start();await transport.send({jsonrpc:'2.0',id:7,method:'tools/list'});expect(posts).toBe(1);expect(gets).toBe(1);expect(messages).toHaveLength(1);}finally{await transport.close();await fixture.close();}
});
it('cancels stalled legacy startup and closes its socket',async()=>{
 const fixture=await serve((_q,s)=>{s.writeHead(200,{'Content-Type':'text/event-stream'});s.flushHeaders();});const rpc=new McpRpc(new McpHttpTransport(fixture.url,'sse'));const control=new AbortController();
 try{const started=rpc.connect(control.signal);const rejected=expect(started).rejects.toBeDefined();control.abort();await rejected;expect(rpc.closed).toBe(true);}finally{await rpc.close();await fixture.close();}
});
it('frames byte fragments, UTF-8, all newline forms, comments and multiline data',()=>{
 const events:unknown[]=[];const parser=new McpEvents();for(const b of Buffer.from('\uFEFF: hi\r\nevent: message\rdata: {"text":\rdata: "🦈"}\r\rid: cursor\nretry: 5\ndata:\n\n'))parser.push(Uint8Array.of(b),e=>events.push(e));
 expect(events).toEqual([{event:'message',data:'{"text":\n"🦈"}'},{event:'message',data:'',id:'cursor',retry:5}]);
 expect(()=>new McpEvents().push(Buffer.from('data: '+'x'.repeat(4*1024**2)+'\n'),()=>{})).toThrow();
});
