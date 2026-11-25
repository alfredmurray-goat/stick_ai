import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const executable=process.env.STELLAN_TEST_HOST;
const skip=!executable;
const windows=process.platform==='win32';
// Same quoting the app uses for Windows command lines (quoteWindowsArgument).
const quote=v=>/^[^\s"]+$/.test(v)?v:'"'+v.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
const bridgeArgs=(dir,file,args)=>windows?['--mcp-bridge',dir,'--cmdline',file,[file,...args].map(quote).join(' ')]:['--mcp-bridge',dir,'--',file,...args];
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async(check,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,50));}return false;};
// An MCP-like program: echoes lines, starts a long-lived grandchild and records its PID.
const program=dir=>`const {spawn}=require('node:child_process');const fs=require('node:fs');
const g=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(join(dir,'grandchild'))},String(g.pid));
fs.writeFileSync(${JSON.stringify(join(dir,'cwd'))},process.cwd());
process.stdin.on('data',d=>{if(String(d).includes('quit'))process.exit(3);process.stdout.write('echo:'+d);});`;
function start(dir){
 const child=spawn(executable,bridgeArgs(dir,process.execPath,['-e',program(dir)]),{stdio:['pipe','pipe','pipe','pipe'],detached:!windows});
 let out='';child.stdout.on('data',d=>{out+=d;});
 return {child,output:()=>out};
}
test('native MCP bridge passes stdio straight through and runs the program in its folder',{skip},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stellan-bridge-'));
 const {child,output}=start(dir);
 try{
  child.stdin.write('{"jsonrpc":"2.0","id":1}\n');
  assert.ok(await until(()=>output().includes('echo:{"jsonrpc":"2.0","id":1}')));
  // Windows may report the short (8.3) form of the same folder; compare fully resolved names.
  const {realpathSync}=await import('node:fs');
  assert.equal(realpathSync.native(await readFile(join(dir,'cwd'),'utf8')),realpathSync.native(dir));
 }finally{try{windows?child.kill():process.kill(-child.pid,'SIGKILL');}catch{} if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r)); await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
test('closing the lifeline ends the program and everything it started',{skip},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stellan-bridge-'));
 const {child}=start(dir);
 try{
  assert.ok(await until(async()=>{try{return Number(await readFile(join(dir,'grandchild'),'utf8'))>0;}catch{return false;}}));
  const grandchild=Number(await readFile(join(dir,'grandchild'),'utf8'));
  assert.ok(alive(grandchild));
  child.stdio[3].destroy();
  assert.ok(await until(()=>!alive(grandchild)),'grandchild should be gone');
  assert.ok(await until(()=>child.exitCode!==null||child.signalCode!==null),'bridge should exit');
 }finally{try{windows?child.kill():process.kill(-child.pid,'SIGKILL');}catch{} if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r)); await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
test('when the program exits, its leftover descendants are ended too',{skip},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stellan-bridge-'));
 const {child}=start(dir);
 try{
  assert.ok(await until(async()=>{try{return Number(await readFile(join(dir,'grandchild'),'utf8'))>0;}catch{return false;}}));
  const grandchild=Number(await readFile(join(dir,'grandchild'),'utf8'));
  child.stdin.write('quit\n');
  assert.ok(await until(()=>!alive(grandchild)),'grandchild should be gone');
 }finally{try{windows?child.kill():process.kill(-child.pid,'SIGKILL');}catch{} if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r)); await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
test('a missing program is reported plainly',{skip},async()=>{
 const child=spawn(executable,bridgeArgs(tmpdir(),windows?'C:\\nonexistent\\mcp-server.exe':'/nonexistent/mcp-server',[]),{stdio:['pipe','pipe','pipe','pipe'],detached:!windows});
 let err='';child.stderr.on('data',d=>{err+=d;});
 await new Promise(r=>child.once('close',r));
 assert.match(err,/could not be started/);
});
