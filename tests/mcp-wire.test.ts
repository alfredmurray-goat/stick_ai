import {expect, it} from 'vitest';
import {JSONRPCMessageSchema} from '@modelcontextprotocol/sdk/types.js';
import {parseMcpMessage} from '../src/portable/mcp-wire.js';

it('accepts independent protocol examples and agrees with the existing SDK envelope checks', () => {
  const messages = [
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'p',progress:1,total:3}},
    {jsonrpc:'2.0',id:'server-ping',method:'ping'},
    {jsonrpc:'2.0',id:5,result:{content:[{type:'text',text:'æ 🦈'}],_meta:{progressToken:'p'}}},
    {jsonrpc:'2.0',id:7,error:{code:-32601,message:'Method not found',data:{method:'unsupported'}}},
    {jsonrpc:'2.0',error:{code:-32700,message:'Parse error'}}
  ];
  for (const message of messages) {
    expect(JSONRPCMessageSchema.safeParse(message).success).toBe(true);
    expect(parseMcpMessage(message)).toEqual(message);
  }
});

it('rejects malformed or ambiguous envelopes before dispatch', () => {
  const malformed = [null, [], {}, {jsonrpc:'1.0',id:1,result:{}}, {jsonrpc:'2.0',id:null,result:{}},
    {jsonrpc:'2.0',id:1.5,method:'ping'}, {jsonrpc:'2.0',id:1,method:'ping',result:{}},
    {jsonrpc:'2.0',method:'ping',params:[]}, {jsonrpc:'2.0',id:1,result:[]},
    {jsonrpc:'2.0',id:1,error:{code:'bad',message:'bad'}},
    {jsonrpc:'2.0',id:1,result:{_meta:{progressToken:false}}},
    {jsonrpc:'2.0',method:'ping',params:{_meta:{'io.modelcontextprotocol/related-task':{taskId:3}}}},
    {jsonrpc:'2.0',id:1,result:{},extra:true}];
  for (const message of malformed) {
    expect(JSONRPCMessageSchema.safeParse(message).success).toBe(false);
    expect(() => parseMcpMessage(message)).toThrow('MCP message');
  }
});

it('bounds nesting, aggregate content, node count and non-JSON values', () => {
  let nested:unknown = {};
  for(let i=0;i<66;i++) nested={nested};
  const cycle:Record<string,unknown>={};cycle.self=cycle;
  for(const result of [nested,cycle,{text:'x'.repeat(4*1024**2+1)},{items:Array(100001).fill(0)}, {value:NaN}, {value:undefined}, {value:new Date()}]) {
    expect(() => parseMcpMessage({jsonrpc:'2.0',id:1,result})).toThrow('MCP message');
  }
  const prototypeKey=JSON.parse('{"jsonrpc":"2.0","id":1,"result":{"__proto__":{"polluted":true}}}');
  expect(parseMcpMessage(prototypeKey)).toEqual(prototypeKey);
  expect(({} as Record<string,unknown>).polluted).toBeUndefined();
});
