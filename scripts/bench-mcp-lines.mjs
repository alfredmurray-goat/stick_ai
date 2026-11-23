import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {McpLines} from '../dist/portable/mcp-lines.js';

// Isolate framing/copying. This does not measure JSON parsing, RPC, tools or the whole app.
if (process.argv[2] === '--worker') {
 const [arm,fragmentText] = process.argv.slice(3), fragment = Number(fragmentText);
 if (!['previous','candidate'].includes(arm) || ![64,4096].includes(fragment)) throw Error('Invalid worker');
 const size=256*1024, input=Buffer.alloc(size+1,120);input[size]=10;
 const reader=new McpLines();let previous=Buffer.alloc(0),received=0;
 const consume=line=>{if(line.length!==size||line[0]!==120||line.at(-1)!==120)throw Error('Framing mismatch');received++;};
 const cpu=process.cpuUsage(),start=performance.now();
 for(let repeat=0;repeat<8;repeat++)for(let offset=0;offset<input.length;offset+=fragment){
  const chunk=input.subarray(offset,offset+fragment);
  if(arm==='candidate')reader.push(chunk,consume);
  else {
   previous=Buffer.concat([previous,chunk]);let end;
   while((end=previous.indexOf(10))>=0){if(end>4*1024**2)throw Error('Oversized line');const line=previous.subarray(0,end);previous=previous.subarray(end+1);if(line.length)consume(line);}
   if(previous.length>4*1024**2)throw Error('Oversized line');
  }
 }
 const wallMs=performance.now()-start,used=process.cpuUsage(cpu);
 if(received!==8)throw Error('Incomplete frames');
 console.log(JSON.stringify({arm,fragmentBytes:fragment,messages:received,payloadBytes:size,wallMs,cpuMs:(used.user+used.system)/1000,peakRssBytes:process.resourceUsage().maxRSS*1024,retainedFramingCapacityBytes:arm==='candidate'?reader.capacityBytes:previous.buffer.byteLength}));
} else {
 const output=process.argv[2];if(!output)throw Error('Build first, then: node scripts/bench-mcp-lines.mjs NEW_REPORT.json');
 const report={date:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,complete:false,purpose:'Fresh-process isolated NDJSON fragmentation diagnostic',limitations:['Synthetic 256 KiB lines; 64-byte fragments stress incremental copying','No JSON parsing, SDK, model, tool execution or whole-app measurement','Peak RSS includes Node and allocator behavior; shared host timing can vary'],runs:[]};
 writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 for(const fragment of [64,4096])for(let round=0;round<5;round++)for(const arm of round%2?['candidate','previous']:['previous','candidate']){
  const result=JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--worker',arm,String(fragment)],{encoding:'utf8'}));
  report.runs.push({round,...result});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 }
 report.complete=true;writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 console.log('Saved isolated framing measurements to '+output);
}
