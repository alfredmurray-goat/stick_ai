import {McpWireError,parseMcpMessage} from './mcp-wire.js';
import type {Tool} from './mcp-types.js';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function requireValue(ok:unknown):asserts ok{if(!ok)throw new McpWireError();}
function checked(v:unknown):asserts v is Record<string,unknown>{parseMcpMessage({jsonrpc:'2.0',id:0,result:v});requireValue(object(v));}
function optionalString(v:Record<string,unknown>,key:string){if(key in v)requireValue(typeof v[key]==='string');}
function annotations(v:Record<string,unknown>){
 if(v.annotations===undefined)return;requireValue(object(v.annotations));const a=v.annotations;
 if(a.audience!==undefined)requireValue(Array.isArray(a.audience)&&a.audience.every(x=>x==='user'||x==='assistant'));
 if(a.priority!==undefined)requireValue(typeof a.priority==='number'&&a.priority>=0&&a.priority<=1);
 optionalString(a,'lastModified');
}
function schema(v:unknown){requireValue(object(v)&&v.type==='object');if(v.properties!==undefined)requireValue(object(v.properties));if(v.required!==undefined)requireValue(Array.isArray(v.required)&&v.required.every(x=>typeof x==='string'));}
export function parseToolList(v:unknown):{tools:Tool[];nextCursor?:string}{
 checked(v);requireValue(Array.isArray(v.tools));optionalString(v,'nextCursor');
 for(const t of v.tools){requireValue(object(t)&&typeof t.name==='string'&&t.name.length>0);schema(t.inputSchema);optionalString(t,'description');optionalString(t,'title');if(t.outputSchema!==undefined)schema(t.outputSchema);
  if(t.annotations!==undefined){requireValue(object(t.annotations));optionalString(t.annotations,'title');for(const key of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'])if(key in t.annotations)requireValue(typeof t.annotations[key]==='boolean');}
  if(t.execution!==undefined)requireValue(object(t.execution)&&(t.execution.taskSupport===undefined||['forbidden','optional','required'].includes(String(t.execution.taskSupport))));
 }
 return {tools:v.tools as Tool[],...(typeof v.nextCursor==='string'?{nextCursor:v.nextCursor}:{})};
}
export interface ToolContent {type:string;text?:string;resource?:Record<string,unknown>&{text?:string}}
export function parseToolResult(v:unknown):{content:ToolContent[];structuredContent?:Record<string,unknown>;isError?:boolean}{
 checked(v);requireValue(v.content===undefined||Array.isArray(v.content));if(v.isError!==undefined)requireValue(typeof v.isError==='boolean');if(v.structuredContent!==undefined)requireValue(object(v.structuredContent));
 const content=v.content??[];requireValue(Array.isArray(content));
 for(const c of content){requireValue(object(c)&&typeof c.type==='string');annotations(c);
  if(c.type==='text')requireValue(typeof c.text==='string');
  else if(c.type==='image'||c.type==='audio')requireValue(typeof c.data==='string'&&typeof c.mimeType==='string');
  else if(c.type==='resource_link'){requireValue(typeof c.uri==='string'&&typeof c.name==='string');optionalString(c,'description');optionalString(c,'mimeType');}
  else if(c.type==='resource'){requireValue(object(c.resource)&&typeof c.resource.uri==='string');optionalString(c.resource,'mimeType');optionalString(c.resource,'text');optionalString(c.resource,'blob');requireValue(typeof c.resource.text==='string'||typeof c.resource.blob==='string');}
  else throw new McpWireError();
 }
 return {content:content as ToolContent[],...(v.structuredContent!==undefined?{structuredContent:v.structuredContent as Record<string,unknown>} :{}),...(typeof v.isError==='boolean'?{isError:v.isError}:{})};
}
