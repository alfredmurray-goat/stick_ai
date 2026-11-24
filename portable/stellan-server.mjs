import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {openNativeSession} from '../experimental/stellan-runtime/session.mjs';

export function chatPrompt(messages, model) {
 if(!Array.isArray(messages)||messages.length<1||messages.length>1024||messages.some(m=>!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'))throw Error('Use bounded text chat messages');
 const system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
 const turns=messages.filter(m=>m.role!=='system');if(!turns.length||turns[0].role!=='user')throw Error('A user message is required');
 let prompt=model==='stellan-1-max'?`<s>[SYSTEM_PROMPT]${system}[/SYSTEM_PROMPT]`:'<s>';
 for(let i=0;i<turns.length;i++){
  const m=turns[i];
  if(m.role==='user')prompt+=`[INST] ${i===0&&model!=='stellan-1-max'&&system?system+'\n\n':''}${m.content} [/INST]`;
  else prompt+=(/^\s/.test(m.content)?m.content:' '+m.content)+'</s>';
 }
 if(Buffer.byteLength(prompt)>1048576)throw Error('Shorten this conversation before continuing');
 return prompt;
}
async function body(req){let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>1048576)throw Error('Request exceeds 1 MiB');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
export async function startStellanServer(config,openSession=openNativeSession){
 const key=Buffer.from(config.key);if(key.length<32)throw Error('A private server key is required');
 let session,opening,busy=false,active,metrics={};
 async function ready(){if(session?.active)return session;if(!opening)opening=openSession({...config,tagged:config.modelName==='stellan-1-lite'}).then(value=>{session=value;config.onProcess?.(value.process);return value;}).finally(()=>{opening=undefined;});return opening;}
 await ready();
 const server=createServer(async(req,res)=>{
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const path=new URL(req.url??'/', 'http://127.0.0.1').pathname;
  if(req.headers.origin){json(403,{error:'Browser origins are not accepted'});return;}
  if(path==='/health'&&req.method==='GET'){json(200,{status:'ok',runtime:'stellan-run'});return;}
  const supplied=Buffer.from((req.headers.authorization??'').replace(/^Bearer /,''));
  if(supplied.length!==key.length||!timingSafeEqual(supplied,key)){json(401,{error:'Unauthorized'});return;}
  if(path==='/v1/models'&&req.method==='GET'){json(200,{data:[{id:config.modelName,owned_by:'Locali Labs'}]});return;}
  if(path==='/slots'&&req.method==='GET'){json(200,[{id:0,n_ctx:config.context,n_past:metrics.prompt_tokens??0,is_processing:busy}]);return;}
  if(path==='/capabilities'){json(200,{runtime:'Stellan-Run',compute:'cpu',sampling:'greedy',grammar:false,slotPersistence:false,splitModels:true});return;}
  if(path.startsWith('/slots/')){json(501,{error:'Stellan-Run re-reads prompts after model swaps; disk slot snapshots are unavailable'});return;}
  if(req.method!=='POST'||!['/v1/chat/completions','/completion','/apply-template'].includes(path)){json(404,{error:'Unknown endpoint'});return;}
  let input;try{req.setTimeout(30000,()=>req.destroy());input=await body(req);req.setTimeout(0);}catch{json(400,{error:'Use a valid JSON request under 1 MiB'});return;}
  if(path==='/apply-template'){try{json(200,{prompt:chatPrompt(input.messages,config.modelName)});}catch(error){json(400,{error:error.message});}return;}
  if(busy){json(409,{error:'One Stellan-Run request is already active'});return;}
  const control=new AbortController();active=control;busy=true;
  const cancel=()=>{if(!res.writableEnded)control.abort();};res.once('close',cancel);
  const event=value=>{if(res.writableLength>1048576)throw Error('The response reader is too slow');res.write('data: '+JSON.stringify(value)+'\n\n');};
  try{
   if(input.model!==undefined&&input.model!==config.modelName)throw Error('This model is not loaded');
   const prompt=path==='/completion'?input.prompt:chatPrompt(input.messages,config.modelName);
   const max=input.max_tokens??input.n_predict??2048;
   if(typeof prompt!=='string'||!Number.isSafeInteger(max)||max<0||max>4096)throw Error('Use text and a token limit from 0 to 4096');
   const native=await ready();
   if(path==='/v1/chat/completions'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.flushHeaders();
    event({choices:[{delta:{role:'assistant'}}],stellan_runtime:{name:'Stellan-Run',compute:'cpu',sampling:'greedy',grammar_enforced:false}});
   }
   let lastText='';
   const result=await native.generate(prompt,{maxTokens:Math.max(1,max),signal:control.signal,onEvent:e=>{
    if(path!=='/v1/chat/completions')return;
    if(e.event==='token'&&e.text){if(config.modelName==='stellan-1-lite'){if(lastText)event({choices:[{delta:{content:lastText}}]});lastText=e.text;}else event({choices:[{delta:{content:e.text}}]});}
    if(e.event==='prompt_progress')event({choices:[],prompt_progress:{processed:e.completed,total:e.total}});
   }});
   metrics={prompt_tokens:result.metrics.reused_tokens+result.metrics.evaluated_prompt_tokens,completion_tokens:max===0?0:result.tokens.length};
   if(path==='/completion'){json(200,{content:max===0?'':result.text,tokens:max===0?[]:result.tokens,timings:result.metrics});return;}
   // Flush the closing token only after the native request has settled. A client stopping at
   // its first complete block must not abort a completed worker and discard its exact prefix.
   if(lastText)event({choices:[{delta:{content:lastText}}]});
   event({choices:[{delta:{},finish_reason:result.metrics.stop_reason==='length'?'length':result.metrics.stop_reason?'stop':result.tokens.length>=max?'length':'stop'}],usage:metrics});res.end('data: [DONE]\n\n');
  }catch(error){control.abort();if(!res.headersSent)json(400,{error:error.message});else if(!res.destroyed){if(res.writableLength>1048576)res.destroy();else res.end('data: '+JSON.stringify({error:{message:error.message}})+'\n\n');}}
  finally{res.removeListener('close',cancel);active=undefined;busy=false;}
 });
 server.maxConnections=8;server.requestTimeout=0;server.headersTimeout=10000;
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});}catch(error){await session?.close();throw error;}
 return {server,async close(){active?.abort();server.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),session?.close()]);}};
}
async function main(){
 const options={};for(let i=2;i<process.argv.length;i++){const flag=process.argv[i];if(flag==='--stellan-server')continue;if(!flag.startsWith('--')||i+1>=process.argv.length||flag in options)throw Error('Invalid Stellan-Run server options');options[flag]=process.argv[++i];}
 const running=await startStellanServer({executable:options['--engine'],executableSha256:options['--engine-sha256'],model:options['--model'],sha256:options['--model-sha256'],modelName:options['--model-name'],key:(await readFile(options['--key-file'],'utf8')).trim(),port:Number(options['--port']),context:Number(options['--context']),threads:2,kvCache:options['--model-name']==='stellan-1-max'?'q8_0':'f16',...(options['--split']?{splitModel:options['--split'],splitSha256:options['--split-sha256']}:{})});
 let closing=false;const close=()=>{if(closing)return;closing=true;void running.close().finally(()=>process.exit());};process.on('SIGINT',close);process.on('SIGTERM',close);
}
if(process.argv.includes('--stellan-server'))main().catch(error=>{process.stderr.write('Stellan-Run: '+error.message+'\n');process.exitCode=1;});
