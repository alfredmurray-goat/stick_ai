import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {gzipSync,constants} from 'node:zlib';
import {randomBytes} from 'node:crypto';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
function rng(seed:number){return()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};}
it.skipIf(!existsSync(host))('Host decodes gzip exactly like zlib and rejects damaged data',()=>{
 const next=rng(3);
 const inputs=[Buffer.alloc(0),Buffer.from('a'),randomBytes(70000),Buffer.from('hello hello hello '.repeat(20000)),Buffer.concat(Array.from({length:50},()=>Buffer.concat([randomBytes(Math.floor(next()*3000)),Buffer.alloc(Math.floor(next()*5000),Math.floor(next()*256))])))];
 const text=Buffer.from(Array.from({length:300000},(_,i)=>'abcdefgh éö🦈\n'[Math.floor(next()*12)]).join(''));inputs.push(text);
 let checked=0;
 for(const input of inputs)for(const level of [0,1,6,9])for(const strategy of [constants.Z_DEFAULT_STRATEGY,constants.Z_FIXED,constants.Z_HUFFMAN_ONLY,constants.Z_RLE]){
  const gz=gzipSync(input,{level,strategy});
  const out=spawnSync(host,['--gunzip-check'],{input:gz,maxBuffer:64*1024**2});
  expect(out.status,String(out.stderr)).toBe(0);expect(Buffer.compare(out.stdout,input)).toBe(0);checked++;
 }
 const gz=gzipSync(inputs[3]!);
 const flipped=Buffer.from(gz);flipped[Math.floor(gz.length/2)]^=0x40;
 for(const bad of [gz.subarray(0,gz.length-5),flipped,Buffer.concat([gz,Buffer.from('extra')]),Buffer.from('not gzip at all')]){
  expect(spawnSync(host,['--gunzip-check'],{input:bad}).status).toBe(1);
 }
 expect(checked).toBe(96);
},120000);
