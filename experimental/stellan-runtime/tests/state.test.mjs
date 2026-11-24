import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {openNativeState} from '../state.mjs';
const executable=process.env.STELLAN_TEST_HOST;
const key='12345678-1234-4567-8123-123456789abc';
test('verified state client saves with compare-and-swap, persists, and refuses a second owner',{skip:!executable},async()=>{
 const root=await mkdtemp(join(tmpdir(),'stellan-state-'));
 const digest=createHash('sha256').update(await readFile(executable)).digest('hex');
 let client;
 try{
  await assert.rejects(openNativeState({executable,executableSha256:'0'.repeat(64),root}),/hash mismatch/);
  client=await openNativeState({executable,executableSha256:digest,root});
  assert.deepEqual(await client.get(key),{exists:false,revision:'missing',text:''});
  const text='{"format":1,"turns":[]} æ 🦈';
  const saved=await client.put(key,'missing',text);
  assert.equal(saved.revision,createHash('sha256').update(text).digest('hex'));
  await assert.rejects(client.put(key,'missing','overwrite'),error=>error.conflict===true);
  assert.equal((await client.get(key)).text,text);
  // Requests from different callers are serialised: both complete, in order.
  const [a,b]=await Promise.all([client.get(key),client.put(key,saved.revision,'second')]);
  assert.equal(a.text,text);assert.equal(b.revision,createHash('sha256').update('second').digest('hex'));
  await assert.rejects(client.get('../escape'),/lowercase UUID/);
  await assert.rejects(client.put(key,b.revision,'x'.repeat(65537)),/64 KiB/);
  await assert.rejects(openNativeState({executable,executableSha256:digest,root}),/another Stick AI window|disconnected/);
  await client.close();assert.equal(client.isClosed,true);
  client=await openNativeState({executable,executableSha256:digest,root});
  assert.equal((await client.get(key)).text,'second');
 }finally{await client?.close();await rm(root,{recursive:true,force:true});}
});
