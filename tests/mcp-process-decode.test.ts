import {expect,it} from 'vitest';
import {McpProcessTransport} from '../src/portable/mcp-process.js';
it('reuses one strict decoder across many messages and closes on invalid UTF-8',async()=>{
 const transport=new McpProcessTransport(process.execPath,['-e',`process.stdin.once('data',()=>{for(let id=0;id<300;id++)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result:{text:'æ 🦈'}})+'\\n');process.stdout.write(Buffer.from([255,10]));});setInterval(()=>{},1000);`],{...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined))},()=>{});
 const messages:unknown[]=[];
 let error:Error|undefined;
 transport.onmessage=message=>messages.push(message);
 transport.onerror=value=>{error=value;};
 const closed=new Promise<void>(resolve=>{transport.onclose=resolve;});
 try{
  await transport.start();await transport.send({jsonrpc:'2.0',method:'ping'});await closed;
  expect(messages).toHaveLength(300);expect(messages[299]).toEqual({jsonrpc:'2.0',id:299,result:{text:'æ 🦈'}});
  expect(error).toBeInstanceOf(Error);
 }finally{await transport.close();}
},15000);
