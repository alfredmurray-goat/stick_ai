import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {generateKeyPairSync,sign,verify,createPublicKey,hkdfSync,createCipheriv,randomBytes} from 'node:crypto';
import {unwrapModelKey} from '../src/portable/activation.js';
import {updatePublicKey} from '../src/portable/update-key.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
it.skipIf(!existsSync(host))('Host checks Ed25519 signatures and unwraps model keys exactly like the app',()=>{
 const cases:{request:Record<string,unknown>;expected:unknown}[]=[];
 for(let i=0;i<60;i++){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');const message=randomBytes(i*7%300);const signature=sign(null,message,privateKey);
  const der=publicKey.export({format:'der',type:'spki'}).toString('base64');const pem=publicKey.export({format:'pem',type:'spki'}).toString();
  const variants:[Buffer,Buffer,string][]=[[message,signature,der],[message,signature,pem],[Buffer.concat([message,Buffer.from('x')]),signature,der],[message,Buffer.from(signature.map((b,j)=>j===i%64?b^1:b)),der],[message,signature.subarray(0,63),der]];
  for(const [m,s,k] of variants){let ok=false;try{ok=verify(null,m,createPublicKey(k.startsWith('-----')?k:{key:Buffer.from(k,'base64'),format:'der',type:'spki'}),s);}catch{}cases.push({request:{op:'verify',key:k,message:m.toString('base64'),signature:s.toString('base64url')},expected:{ok}});}
 }
 cases.push({request:{op:'verify',key:updatePublicKey,message:'aGk=',signature:'AA'},expected:{ok:false}});
 for(let i=0;i<40;i++){
  const stick=randomBytes(32).toString('hex'),code=`ABCD-EF${i}`,key=randomBytes(32),iv=randomBytes(12);
  const wrapping=Buffer.from(hkdfSync('sha256',Buffer.from(stick,'hex'),'stick-ai-model-keys',code,32));const c=createCipheriv('aes-256-gcm',wrapping,iv);
  const sealed=Buffer.concat([iv,c.update(key),c.final(),c.getAuthTag()]);
  const tampered=Buffer.from(sealed);tampered[20+i%30]^=1;
  for(const [w,s,k] of [[sealed,stick,code],[tampered,stick,code],[sealed,stick,code+'x'],[sealed.subarray(1),stick,code]] as [Buffer,string,string][]){
   const out=unwrapModelKey(w.toString('base64'),s,k);cases.push({request:{op:'unwrap',wrapped:w.toString('base64'),stick:s,code:k},expected:{key:out?out.toString('base64'):null}});
  }
 }
 const run=spawnSync(host,['--crypto'],{input:cases.map(c=>JSON.stringify(c.request)).join('\n')+'\n',encoding:'utf8'});
 expect(run.status,run.stderr).toBe(0);const lines=run.stdout.trim().split('\n');expect(lines).toHaveLength(cases.length);
 let valid=0,opened=0;
 for(const [i,c] of cases.entries()){const got=JSON.parse(lines[i]!);expect(got,`case ${i}`).toEqual(c.expected);if((c.expected as {ok?:boolean}).ok)valid++;if((c.expected as {key?:string}).key)opened++;}
 expect(valid).toBe(120);expect(opened).toBe(40);
});
