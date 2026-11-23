import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import {ManagedEngine} from '../dist/portable/engine.js';
import {hashFile} from '../dist/portable/integrity.js';
import {lockModel} from '../dist/portable/model-lock.js';
import {lockedModels,lockedRecords} from '../dist/portable/locked-models.js';
import {linkModelFile} from '../dist/portable/local-models.js';
import {targetFor} from '../dist/portable/platform.js';
import {reservePort} from '../dist/portable/ports.js';
import {Ollama} from '../dist/model/ollama.js';
import {ramStatus} from '../dist/config/models.js';
import {runAgent} from '../dist/agent/index.js';
import {Sandbox} from '../dist/sandbox/paths.js';
import {Tools} from '../dist/tools/index.js';
const [binary,gguf,report]=process.argv.slice(2);if(!binary||!gguf||!report)throw Error('Use ENGINE GGUF NEW_REPORT.json');
const output=resolve(report);await writeFile(output,JSON.stringify({complete:false})+'\n',{flag:'wx',mode:0o600});
const root=await mkdtemp(join(tmpdir(),'stellan-app-')),target=targetFor(process.platform,process.arch),bin=join(root,'bin',target),temporary=join(root,'temp'),project=join(root,'project');
await Promise.all([mkdir(bin,{recursive:true}),mkdir(join(root,'app')),mkdir(join(root,'logs')),mkdir(temporary),mkdir(project)]);
const node=join(bin,process.platform==='win32'?'node.exe':'node'),enginePath=`bin/${target}/stellan-run${process.platform==='win32'?'.exe':''}`;
await copyFile(process.execPath,node);await copyFile(binary,join(root,enginePath));
await build({entryPoints:['portable/stellan-server.mjs'],outfile:join(root,'app/stick-engine.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24'});
await writeFile(join(root,'manifest.json'),JSON.stringify({format:1,runtime:'stellan-run',files:[{path:enginePath,...await hashFile(binary),executable:true}]}));
const locked=process.argv.includes('--locked'),key=locked?randomBytes(32):undefined;
if(locked){
 await mkdir(join(root,'models'));
 const result=await lockModel(resolve(gguf),join(root,lockedModels['stellan-1-lite'].base),key,'stellan-1-lite');
 if(result.firstSha256!==lockedModels['stellan-1-lite'].firstSha256||result.restSha256!==lockedModels['stellan-1-lite'].restSha256)throw Error('Locked model layout differs from pinned release');
 const manifest=JSON.parse(await (await import('node:fs/promises')).readFile(join(root,'manifest.json'),'utf8'));manifest.files.push(...lockedRecords(lockedModels['stellan-1-lite']));await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
}else await linkModelFile(root,'lite',resolve(gguf));
const reservation=await reservePort();await reservation.release();const fd=openSync(join(root,'smoke.log'),'a',0o600);
const engine=new ManagedEngine(root,target,reservation.port,temporary,fd,console.error),signal=AbortSignal.timeout(15*60*1000);
if(key)engine.modelKey=()=>key;
try{
 await engine.start('stellan-1-lite',signal);if(!engine.nativeRuntime)throw Error('Wrong runtime');
 const client=new Ollama('stellan-1-lite',engine.baseUrl,false,ramStatus(),{apiKey:engine.key,maxTokens:256});
 const response=await client.complete([{role:'system',content:'Reply with exactly <done>Ready</done>. Do not call tools or write code.'},{role:'user',content:'Are you ready?'}],signal,()=>{});
 console.log('Native greeting:',response.content);
 if(process.argv.includes('--greeting-only')){await writeFile(output,JSON.stringify({complete:true,runtime:'Stellan-Run',locked,verified:response.content.includes('Ready'),greeting:response.content,scope:'Real activated split-model startup/greeting; no tool-task or benchmark score'},null,2)+'\n');if(!response.content.includes('Ready'))throw Error('Locked model greeting failed');process.exitCode=0;}else{
 const expected='Violet otter '+randomUUID().slice(0,6);await writeFile(join(project,'note.txt'),expected);
 const tools=new Tools(await Sandbox.create(project),async()=>false),messages=[];let read=false,summary='';
 const outcome=await runAgent({task:'Use read_file to read note.txt, then quote its entire contents exactly in your done summary. Do not change files or run programs.',messages,model:client,maxSteps:4,signal,tools:{execute:async(call,stepSignal)=>{if(!['read_file','list_dir','search_files'].includes(call.function.name))return 'Only reading tools are available.';if(call.function.name==='read_file')read=true;return tools.execute(call,stepSignal);}},emit:(text,thinking)=>{if(!thinking)summary+=text;},log:console.log,save:async()=>{}});
 const receipt={complete:true,runtime:'Stellan-Run',compute:'CPU',greeting:response.content,outcome,read,summary,verified:outcome==='finished'&&read&&summary.includes(expected),scope:'Managed app bridge and real Lite read-only tool exchange; not a benchmark or full-Max/GPU qualification'};
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n');if(!receipt.verified)throw Error('Real Lite tool exchange failed');console.log('Stellan-Run app tool exchange passed');}
}finally{engine.disposing=true;await engine.stop();closeSync(fd);await rm(root,{recursive:true,force:true});}
