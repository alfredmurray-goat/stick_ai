import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {McpServers} from '../dist/portable/mcp.js';
import {Skills} from '../dist/portable/skills.js';
import {runAgent} from '../dist/agent/index.js';
import {workspaceToolSchemas} from '../dist/tools/schema.js';
/** Release qualification with the real Lite model and a harmless loopback MCP server. */
export async function extensionSmoke({client,temporary,project,signal}) {
 const expected=randomUUID().slice(0,8);let calls=0;
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(405);res.end();return;}if(req.method==='DELETE'){res.end();return;}
  let body='';for await(const chunk of req)body+=chunk;const message=JSON.parse(body);
  if(!('id'in message)){res.writeHead(202);res.end();return;}
  const result=message.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'release-check',version:'1'}}:message.method==='tools/list'?{tools:[{name:'read_marker',description:'Read the release-check marker.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:(calls++,{content:[{type:'text',text:'MCP result '+expected}]});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const mcp=new McpServers(temporary,project);const skills=new Skills(temporary,project);let discovered=false,loaded=false,summary='';const messages=[];
 try{
  const id=await mcp.add({name:'Release check',transport:'http',url:`http://127.0.0.1:${server.address().port}/mcp`});await mcp.connect(id,signal);await skills.load();const skillId=await skills.save('check-mcp','Check an MCP connection','Discover the specified server using mcp_tools, call read_marker with empty arguments, then report the actual returned marker. Do not guess it.');const skill=await skills.prepare('/check-mcp verify');
  // Lite can take a wrong turn on a small CPU runner. Two attempts of 12 steps, and a
  // wrong tool gets pointed back at the right one, but a pass still needs the real exchange.
  let outcome='';// The hint must lead to the next missing step: pointing straight at mcp_call let Lite skip discovery, which this check requires.
  const wrongTool=()=>discovered?`Not allowed in this check. Next, call mcp_call on server ${id} with tool "read_marker" and arguments {}, then quote the returned marker in <done>.`:`Not allowed in this check. Next, call mcp_tools on server ${id} with query "read_marker", then mcp_call on that server with tool "read_marker" and arguments {}, then quote the returned marker in <done>.`;
  for(let attempt=1;attempt<=2&&!(outcome==='finished'&&calls>0&&summary.includes(expected));attempt++){
  if(attempt>1){console.log('Extension check: retrying with a fresh conversation.');messages.length=0;summary='';}
  outcome=await runAgent({task:`Read the enabled skill ${skillId} using use_skill with resource "". Follow it: use mcp_tools on server ${id} with query "read_marker", then mcp_call on that server with tool "read_marker" and arguments {}. Quote the entire actual returned marker in your done summary.`,extraInstructions:`Additional available tool schemas: ${JSON.stringify(workspaceToolSchemas.map(s=>s.function))}\nConnected server: ${id}.\n${skill.instructions}`,messages,model:client,maxSteps:12,signal,tools:{execute:async(call,stepSignal)=>{
   const args=JSON.parse(call.function.arguments);if(call.function.name==='use_skill'){const result=await skills.readSkill(args.name,args.resource,new Set(skill.active));loaded=true;return result;}
   if(call.function.name==='mcp_tools'){const result=await mcp.tools(args.server,args.query,stepSignal);discovered=true;return result;}
   if(call.function.name==='mcp_call')return mcp.call(args.server,args.tool,args.arguments,stepSignal,async(_label,args)=>JSON.stringify(args)==='{}');return wrongTool();
  }},emit:(text,thinking)=>{if(!thinking)summary+=text;},log:console.log,save:async()=>{}});
  }
  await writeFile(join('release-assets','extension-smoke.json'),JSON.stringify({outcome,loaded,discovered,calls,summary,messages},null,2));if(outcome!=='finished'||!loaded||!discovered||calls<1||!summary.includes(expected))throw Error('Lite did not complete a real skill/MCP discovery/call/result exchange; inspect extension-smoke.json before shipping');console.log('Real Lite passed skill loading and an approved MCP tool exchange.');
 }finally{await mcp.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
