import {expect,it} from 'vitest';
import {ListToolsResultSchema,CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {parseToolList,parseToolResult} from '../src/portable/mcp-results.js';
it('accepts supported tool and content variants alongside the independent SDK oracle',()=>{
 const list={tools:[{name:'read',inputSchema:{type:'object'},outputSchema:{type:'object'},annotations:{readOnlyHint:true},execution:{taskSupport:'optional'}}],nextCursor:'next'};
 expect(ListToolsResultSchema.safeParse(list).success).toBe(true);expect(parseToolList(list).tools[0]?.name).toBe('read');
 for(const item of [{type:'text',text:'hello'},{type:'image',data:'AA==',mimeType:'image/png'},{type:'audio',data:'AA==',mimeType:'audio/wav'},{type:'resource_link',uri:'file:///a',name:'a'},{type:'resource',resource:{uri:'file:///a',text:'hello'}},{type:'resource',resource:{uri:'file:///a',blob:'AA=='}}]){
  const result={content:[item],structuredContent:{ok:true},isError:false};expect(CallToolResultSchema.safeParse(result).success).toBe(true);expect(parseToolResult(result).content).toHaveLength(1);
 }
});
it('rejects malformed schemas and result payloads before model context',()=>{
 for(const value of [{tools:[{name:'bad',inputSchema:{type:'string'}}]},{tools:[{name:'bad',inputSchema:{type:'object',required:[5]}}]}])expect(()=>parseToolList(value)).toThrow();
 for(const content of [[{type:'text',text:8}],[{type:'image',data:'AA=='}],[{type:'resource',resource:{uri:'file:///a'}}],[{type:'text',text:'x',annotations:{priority:2}}]])expect(()=>parseToolResult({content})).toThrow();
});
it('ships the Stellan-Link module without SDK or schema-library runtime code',async()=>{
 const {build}=await import('esbuild');
 const result=await build({entryPoints:['src/portable/mcp.ts'],bundle:true,platform:'node',format:'cjs',write:false,metafile:true});
 expect(Object.keys(result.metafile!.inputs).some(p=>p.includes('@modelcontextprotocol/')||p.includes('/zod/'))).toBe(false);
});
