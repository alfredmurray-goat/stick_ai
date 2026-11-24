import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {openNativeWorkspace} from '../workspace.mjs';
const executable=process.env.STELLAN_TEST_HOST;
test('verified native owner client requires approval and rejects concurrent/tampered changes',{skip:!executable},async()=>{
 const root=await mkdtemp(join(tmpdir(),'stellan-owner-'));
 const digest=createHash('sha256').update(await readFile(executable)).digest('hex');
 let client;
 try{
  await assert.rejects(openNativeWorkspace({executable,executableSha256:'0'.repeat(64),root}),/hash mismatch/);
  client=await openNativeWorkspace({executable,executableSha256:digest,root});
  assert.equal(await client.execute('write_file',['nested/æ.txt','hello native']),'Denied by user');
  await assert.rejects(readFile(join(root,'nested/æ.txt')));
  assert.equal(await client.execute('write_file',['truthy.txt','bad'],{approve:async()=> 'deny'}),'Denied by user');
  await assert.rejects(readFile(join(root,'truthy.txt')));
  let release,entered;
  const shown=new Promise(resolve=>{entered=resolve;});
  const approval=new Promise(resolve=>{release=resolve;});
  const change=client.execute('write_file',['nested/æ.txt','hello native'],{approve:proposal=>{assert.equal(proposal.path,'nested/æ.txt');entered();return approval;}});
  await shown;await assert.rejects(client.execute('list_dir',['.']),/active/);release(true);await change;
  assert.equal(await client.execute('read_file',['nested/æ.txt']),'hello native');
  await assert.rejects(client.execute('write_file',['nested/æ.txt','proposal'],{approve:async()=>{await writeFile(join(root,'nested/æ.txt'),'external');return true;}}),/changed/);
  assert.equal(await readFile(join(root,'nested/æ.txt'),'utf8'),'external');
  await assert.rejects(client.execute('write_file',['throw.txt','bad'],{approve:()=>{throw Error('UI cancelled');}}),/UI cancelled/);
  await client.execute('write_file',['fine.txt','after denied'],{approve:async()=>true});
  const control=new AbortController();
  await assert.rejects(client.execute('write_file',['cancelled.txt','bad'],{signal:control.signal,approve:async()=>{control.abort();return true;}}));
  await client.closed;await assert.rejects(readFile(join(root,'cancelled.txt')));
 }finally{await client?.close();await rm(root,{recursive:true,force:true});}
});

test('cancellation settles an unanswered approval and releases the native owner process',{skip:!executable,timeout:5000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'stellan-approval-cancel-'));
 let client;
 try{
  const digest=createHash('sha256').update(await readFile(executable)).digest('hex');
  client=await openNativeWorkspace({executable,executableSha256:digest,root});
  const control=new AbortController();let shown;
  const entered=new Promise(resolve=>{shown=resolve;});
  const operation=client.execute('write_file',['never.txt','bad'],{signal:control.signal,approve:()=>{shown();return new Promise(()=>{});}});
  const rejected=assert.rejects(operation);
  await entered;control.abort();await rejected;await client.closed;
  await assert.rejects(readFile(join(root,'never.txt')));
 }finally{await client?.close();await rm(root,{recursive:true,force:true});}
});
