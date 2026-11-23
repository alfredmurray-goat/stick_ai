import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync, createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { readTokenizer } from './tokenizer.mjs';
import { openNativeSession } from './session.mjs';
import { resolve } from 'node:path';
import { totalmem, platform, arch } from 'node:os';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const [nativePath, referencePath, modelPath, sha256, outputPath, repeatText = '5'] = process.argv.slice(2);
if (![nativePath, referencePath, modelPath, outputPath].every(v => typeof v === 'string' && v.length) || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw Error('Usage: node bench-sessions.mjs NATIVE LLAMA_SERVER MODEL SHA256 OUTPUT.json [REPEATS]');
const repetitions = Number(repeatText);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw Error('Repetitions must be 1..20');
if (process.env.STELLAN_RUNTIME_PRECISE || process.env.STELLAN_RUNTIME_SCALAR) throw Error('This diagnostic requires the default candidate arithmetic mode');
const model=resolve(modelPath), executable=resolve(nativePath), reference=resolve(referencePath);
const output=resolve(outputPath);
if ([model, executable, reference].includes(output)) throw Error('Output must be a separate new report file');
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort); process.once('SIGTERM', abort);
const portReservation = createServer();
await new Promise((accept,reject) => { portReservation.once('error',reject); portReservation.listen(0,'127.0.0.1',accept); });
const port=portReservation.address().port;
await new Promise((accept,reject) => portReservation.close(error => error ? reject(error) : accept()));
function post(path, body, key) {
  return new Promise((accept,reject) => {
    const req=request({ hostname:'127.0.0.1', port, path, method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`}, signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1800000)]) }, response => {
      let bytes=0, chunks=[];
      response.on('data',chunk => { bytes+=chunk.length; if(bytes>8388608)req.destroy(Error('Response exceeds limit')); else chunks.push(chunk); });
      response.on('error',reject);
      response.on('end',() => { try { if(response.statusCode!==200)throw Error(`Reference HTTP ${response.statusCode}`); accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch(error) { reject(error); } });
    });
    req.on('error',reject); req.end(JSON.stringify(body));
  });
}
const digest=createHash('sha256');
for await(const bytes of createReadStream(model)){controller.signal.throwIfAborted();digest.update(bytes);}
if(digest.digest('hex')!==sha256)throw Error('Model integrity check failed');
const tokenizer=await readTokenizer(model);
const prompts=['<s>[INST] Write a Python function add(a, b) that returns their sum. Return only code. [/INST]', '<s>[INST] Write a Python function square(n) that returns n times n. Return only code. [/INST]'];
const max = tokenizer.mode === 'gpt2';
if (max && totalmem() < 24 * 1024 ** 3) throw Error('Use at least 24 GiB reported RAM for the full Max diagnostic');
const report={format:1,baselineIsShippingConfiguration:false,physicalHardwareValidated:false,hardware:{platform:platform(),arch:arch(),ramBytes:totalmem()},model:max?'stellan-1-max':'stellan-1-lite',purpose:'matched 8192-context CPU diagnostic; not full application qualification',modelSha256:sha256,expectedReferenceCommit:'cd959bae99ff4bed22bef2604f45241c09bbb8c8',referenceCommitVerified:false,complete:false,referenceBinarySha256:createHash('sha256').update(readFileSync(reference)).digest('hex'),candidateBinarySha256:createHash('sha256').update(readFileSync(executable)).digest('hex'),threads:2,context:8192,maxTokens:12,baseline:[],candidate:[]};
report.limitations=['CPU only; 8192 context; two short synthetic coding prompts','All baseline requests precede candidate requests; repetitions are not alternating pairs','Baseline cache_prompt is false; prompts are independent','Baseline startup excludes app integrity verification; candidate startup verifies the entire model','A matching token stream is not an agent quality benchmark','Use physical devices, normal GPU/settings, more tasks and matched startup verification before replacement'];
const reportFd=openSync(output,'wx',0o600); closeSync(reportFd);
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const temporary = await mkdtemp(resolve(tmpdir(), 'stellan-run-bench-'));
const logFile=resolve(temporary,'reference.log');
const keyFile=resolve(temporary,'key');
const key=randomBytes(32).toString('hex');
await writeFile(keyFile,key,{mode:0o600});
const fd=openSync(logFile,'w',0o600);
const args=['--model',model,'--alias',report.model,'--host','127.0.0.1','--port',String(port),'--ctx-size','8192','--threads','2','--threads-batch','2','--gpu-layers','0','--no-repack','--api-key-file',keyFile,'--parallel','1','--batch-size',max?'128':'512','--ubatch-size',max?'64':'256','--cache-ram','0',...(max?['--flash-attn','on','--cache-type-k','q8_0','--cache-type-v','q8_0','--spec-type','ngram-simple']:['--ctx-checkpoints','1','--no-jinja','--skip-chat-parsing','--chat-template','mistral-v1']),'--no-webui','--no-warmup'];
report.referenceArgs=args.map(a=>a===model?'<pinned-model.gguf>':a===keyFile?'<temporary-key-file>':a);
const server=spawn(reference,args,{stdio:['ignore',fd,fd]});
const serverClosed=new Promise(r=>server.once('close',r));
const closeServer=async()=>{ if(server.pid && server.exitCode===null && server.signalCode===null)server.kill('SIGTERM'); const kill=setTimeout(()=>server.kill('SIGKILL'),2000); kill.unref(); await serverClosed; clearTimeout(kill); };
server.once('error',error=>{ controller.abort(error); });
const start=performance.now();
try{
 for(let i=0;;i++){
  controller.signal.throwIfAborted();
  if(server.exitCode!==null)throw Error('Server failed: '+readFileSync(logFile,'utf8').slice(-2000));
  try{if((await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1000)])})).ok)break;}catch{}
  if(i>240)throw Error('Startup timeout');
  await new Promise(r=>setTimeout(r,500));
 }
 report.baselineStartupMs=performance.now()-start;
 report.baselineBeforeRequests=(platform()==='linux'?readFileSync(`/proc/${server.pid}/stat`,'utf8'):null);
 for(let repeat=0;repeat<repetitions;repeat++)for(const prompt of prompts){
  const ids=tokenizer.encode(prompt),began=performance.now();
  const result=await post('/completion',{prompt:ids,n_predict:12,temperature:0,cache_prompt:false,return_tokens:true,seed:0},key);
  if(result.error)throw Error(JSON.stringify(result.error));
  if(!Array.isArray(result.tokens)||!result.tokens.every(Number.isInteger)||!Number.isFinite(result.timings?.prompt_ms)||!Number.isFinite(result.timings?.predicted_ms))throw Error('Reference returned incomplete tokens or metrics');
  report.baseline.push({repeat,prompt,tokens:result.tokens,text:result.content,timings:result.timings,wallMs:performance.now()-began});
  writeFileSync(output,JSON.stringify(report,null,2));
  process.stderr.write('baseline '+repeat+' '+result.timings?.prompt_ms+'ms prompt, '+result.timings?.predicted_ms+'ms decode\n');
 }
 report.baselineProcStatus=platform()==='linux'?readFileSync(`/proc/${server.pid}/status`,'utf8').split('\n').filter(l=>/^(VmRSS|VmHWM):/.test(l)):null;
 report.baselineAfterRequests=(platform()==='linux'?readFileSync(`/proc/${server.pid}/stat`,'utf8'):null);
}finally{await closeServer();closeSync(fd);await rm(temporary,{recursive:true,force:true});}
const session=await openNativeSession({executable,executableSha256:report.candidateBinarySha256,model,sha256,threads:2,context:8192,signal:controller.signal});
report.candidateStartup=session.startup;
try{
 for(let repeat=0;repeat<repetitions;repeat++)for(const prompt of prompts){
  const began=performance.now(), result=await session.generate(prompt,{maxTokens:12,signal:controller.signal});
  report.candidate.push({repeat,prompt,tokens:result.tokens,text:result.text,timings:result.metrics,wallMs:performance.now()-began});
  writeFileSync(output,JSON.stringify(report,null,2));
  process.stderr.write('candidate '+repeat+' '+result.metrics.prompt_ms+'ms prompt, '+result.metrics.decode_ms+'ms decode\n');
 }
}finally{await session.close();}

report.complete=true;
report.identicalGeneratedIds=report.baseline.length===report.candidate.length&&report.baseline.every((run,i)=>JSON.stringify(run.tokens)===JSON.stringify(report.candidate[i]?.tokens));

writeFileSync(output,JSON.stringify(report,null,2)+'\n');
process.off('SIGINT',abort);process.off('SIGTERM',abort);
process.stdout.write(JSON.stringify({report:output,identicalGeneratedIds:report.identicalGeneratedIds})+'\n');
