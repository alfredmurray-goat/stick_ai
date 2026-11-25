import {expect,it} from 'vitest';
import {copyFile,cp,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {LATEST_PROTOCOL_VERSION} from '@modelcontextprotocol/sdk/types.js';
import {McpServers,nativeBridgeArgs} from '../src/portable/mcp.js';
import {targetFor,executableName} from '../src/portable/platform.js';
import {hashFile} from '../src/portable/integrity.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
const server=`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;const result=m.method==='initialize'?{protocolVersion:'${LATEST_PROTOCOL_VERSION}',capabilities:{tools:{}},serverInfo:{name:'stdio',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.FIXTURE_SECRET+' '+m.params.arguments.text}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`;
async function stick(tamper=false){
 const root=await mkdtemp(join(tmpdir(),'stick-native-mcp-')),project=join(root,'app/project'),target=targetFor(process.platform,process.arch),bin=join(root,'bin',target);
 await mkdir(project,{recursive:true});await mkdir(bin,{recursive:true});
 await copyFile(process.execPath,join(bin,executableName(target,true)));
 const path=`bin/${target}/stellan-host${process.platform==='win32'?'.exe':''}`;await cp(host,join(root,path));
 const record=await hashFile(join(root,path));
 await writeFile(join(root,'manifest.json'),JSON.stringify({nativeHost:true,files:[{path,...record,sha256:tamper?'0'.repeat(64):record.sha256,executable:true}]}));
 await writeFile(join(project,'server.cjs'),server);
 return {root,project,close:()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
}
it.skipIf(!existsSync(host))('runs stdio MCP servers under the native Host bridge instead of a Node bridge',async()=>{
 const f=await stick();const mcp=new McpServers(f.root,f.project);
 try{
  const id=await mcp.add({name:'Native fixture',transport:'stdio',command:'node',args:['${project}/server.cjs'],env:{FIXTURE_SECRET:'hidden-value'}});
  const signal=new AbortController().signal;await mcp.connect(id,signal);
  expect(await mcp.call(id,'echo',{text:'ok'},signal,async()=>true)).toBe('[redacted] ok');
  if(process.platform!=='win32'){
   const processes=execFileSync('ps',['-ax','-o','args=']).toString();
   expect(processes).toMatch(/stellan-host --mcp-client/);
   expect(processes).not.toMatch(/stick-mcp\.cjs/);
  }
  await mcp.disconnect(id);
  if(process.platform!=='win32')await expect.poll(()=>execFileSync('ps',['-ax','-o','args=']).toString().includes(`${f.project}/server.cjs`)).toBe(false);
 }finally{await mcp.close();await f.close();}
},30000);
it.skipIf(!existsSync(host))('refuses a Host that does not match the package manifest',async()=>{
 const f=await stick(true);const mcp=new McpServers(f.root,f.project);
 try{
  const id=await mcp.add({name:'Native fixture',transport:'stdio',command:'node',args:['${project}/server.cjs']});
  await expect(mcp.connect(id,new AbortController().signal)).rejects.toThrow(/does not match this package/);
 }finally{await mcp.close();await f.close();}
},30000);

it('plans Windows command lines for the native bridge with the same escaping, and never the project folder',()=>{
 const env={PATH:'C:\\Tools',PATHEXT:'.EXE;.CMD',ComSpec:'C:\\Windows\\System32\\cmd.exe'};
 const exists=(path:string)=>path==='C:\\Tools\\npx.cmd'||path==='C:\\Tools\\server.exe';
 expect(nativeBridgeArgs('C:\\proj','server',['a b','c"d'],env,'win32',exists)).toEqual(['--mcp-bridge','C:\\proj','--cmdline','C:\\Tools\\server.exe','"C:\\Tools\\server.exe" "a b" "c\\"d"']);
 const batch=nativeBridgeArgs('C:\\proj','npx',['-y','pkg & calc'],env,'win32',exists)!;
 expect(batch.slice(0,4)).toEqual(['--mcp-bridge','C:\\proj','--cmdline','C:\\Windows\\System32\\cmd.exe']);
 expect(batch[4]).toContain('/d /s /c');expect(batch[4]).toContain('^&');
 expect(nativeBridgeArgs('C:\\proj','missing',[],env,'win32',exists)).toBeUndefined();
 expect(nativeBridgeArgs('/p','node',['x'],{},'linux')).toEqual(['--mcp-bridge','/p','--','node','x']);
});
