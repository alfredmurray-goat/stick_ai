import spawn from 'cross-spawn';
import {killProcessTree} from '../sandbox/process.js';
// Trusted bridge: gives the MCP program its own process group and reaps descendants.
// Secret environment values are never put in command-line arguments or logs.
async function main(){
 const spec=JSON.parse(Buffer.from(process.argv[2]??'','base64').toString('utf8')) as {command:string;args:string[];cwd:string};
 const extra=JSON.parse(process.env.STICK_MCP_ENV_JSON??'{}') as Record<string,string>;delete process.env.STICK_MCP_ENV_JSON;
 if(typeof spec.command!=='string'||!Array.isArray(spec.args)||spec.args.some(a=>typeof a!=='string')||typeof spec.cwd!=='string')throw Error('Invalid MCP process configuration');
 const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:{...process.env,...extra},detached:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stopping:Promise<void>|undefined;
 const stop=()=>stopping??=(async()=>{if(process.platform!=='win32') { try { process.kill(-process.pid,'SIGKILL'); } catch {} } else if(child.pid)await killProcessTree(child.pid,process.platform).catch(()=>{child.kill('SIGKILL');});child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();})();
 process.stdin.pipe(child.stdin!);child.stdout!.pipe(process.stdout);child.stderr!.pipe(process.stderr);
 process.stdin.on('end',()=>{void stop().finally(()=>process.exit(0));});
 for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{void stop().finally(()=>process.exit(0));});
 child.on('error',()=>{process.stderr.write('The MCP program could not be started. Check its executable and arguments.\n');void stop().finally(()=>process.exit(1));});
 child.on('exit',code=>{void stop().finally(()=>process.exit(code??1));});
 child.stdin?.on('error',()=>{void stop().finally(()=>process.exit(1));});
 process.stdout.on('error',()=>{void stop().finally(()=>process.exit(1));});
}
if(process.argv[1]&&/(?:stick-mcp\.cjs|mcp-stdio-entry\.js)$/.test(process.argv[1]))void main().catch(()=>{process.stderr.write('Invalid MCP process configuration.\n');process.exitCode=1;});
