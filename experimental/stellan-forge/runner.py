#!/usr/bin/env python3
"""One-attempt Forge task runner. Local Docker only; no image pulls or hosted jobs."""
import argparse
import collections
import contextlib
import hashlib
import json
import itertools
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import forge

STATUSES = {'passed', 'failed', 'incomplete', 'infrastructure_error'}

def relative(value):
    if not isinstance(value,str) or len(value)>240 or '\\' in value or '\0' in value or ':' in value or any(p in {'','.', '..'} or p.endswith(('.', ' ')) or re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p) for p in value.split('/')):
        raise ValueError('Use safe relative task paths')
    return value

def snapshot(source,destination):
    source=Path(source)
    if source.is_symlink() or not source.is_dir(): raise ValueError('Task inputs must be directories without symlinks')
    destination.mkdir(mode=0o700)
    records=[];total=0
    entries=list(itertools.islice(source.rglob('*'),4001))
    if len(entries)>4000:raise ValueError('Task snapshot exceeds entry budget')
    for visited,path in enumerate(sorted(entries),1):
        if visited>4000:raise ValueError('Task snapshot exceeds entry budget')
        name=relative(path.relative_to(source).as_posix())
        if path.is_symlink(): raise ValueError('Task input symlinks are forbidden')
        target=destination/name
        if path.is_dir(): target.mkdir(mode=0o700);records.append([name+'/', 'directory']);continue
        info=path.stat()
        if not path.is_file() or info.st_nlink!=1: raise ValueError('Task inputs must be regular single-link files')
        total+=info.st_size
        if len(records)>=2000 or total>16*1024**2: raise ValueError('Task snapshot exceeds file or byte budget')
        data=path.read_bytes()
        if len(data)!=info.st_size: raise ValueError('Task input changed while copying')
        target.write_bytes(data);target.chmod(0o600)
        records.append([name,hashlib.sha256(data).hexdigest()])
    return forge.digest(records)

def snapshot_hash(source):
    source=Path(source)
    if source.is_symlink() or not source.is_dir():raise ValueError('Unsafe snapshot directory')
    entries=list(itertools.islice(source.rglob('*'),4001))
    if len(entries)>4000:raise ValueError('Snapshot exceeds entry budget')
    records=[];total=0
    for path in sorted(entries):
        name=relative(path.relative_to(source).as_posix())
        if path.is_symlink():raise ValueError('Snapshot symlinks are forbidden')
        if path.is_dir():records.append([name+'/', 'directory']);continue
        info=path.stat();total+=info.st_size
        if not path.is_file() or info.st_nlink!=1 or len(records)>=2000 or total>16*1024**2:raise ValueError('Unsafe or oversized snapshot')
        with path.open('rb') as stream:data=stream.read(16*1024**2+1)
        if len(data)!=info.st_size:raise ValueError('Snapshot changed while reading')
        records.append([name,hashlib.sha256(data).hexdigest()])
    return forge.digest(records)

def source_in(parent,name):
    relative(name);path=parent
    for part in name.split('/'):
        path=path/part
        if path.is_symlink():raise ValueError('Task source symlinks are forbidden')
    return path

def write_bytes_new(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())

def argv(value):
    if not isinstance(value,list) or not value or len(value)>100 or any(not isinstance(v,str) or '\0' in v or len(v)>4096 for v in value): raise ValueError('Commands must be bounded argv arrays, not shell strings')
    return value

def plan(suite_path,output,image,timeout=300):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}',image): raise ValueError('Use a locally available image pinned by sha256 digest')
    if not isinstance(timeout,int) or not 1<=timeout<=3600: raise ValueError('Timeout must be 1–3600 seconds')
    suite_path=Path(suite_path).resolve();suite=forge.read_json(suite_path)
    if set(suite)!={'format','runtime','adapter_dir','adapter','tasks'} or suite['format']!=1 or not isinstance(suite['tasks'],list) or not 1<=len(suite['tasks'])<=500: raise ValueError('Invalid Forge suite')
    argv(suite['adapter']);relative(suite['adapter_dir'])
    output=Path(output);output.mkdir(mode=0o700)
    try:
        inputs=output/'inputs';inputs.mkdir(mode=0o700)
        adapter_hash=snapshot(source_in(suite_path.parent,suite['adapter_dir']),inputs/'adapter')
        tasks=[];ids=set()
        for task in suite['tasks']:
            if set(task)!={'id','prompt','bundle','verifier','repository','revision','family','source','purpose'}: raise ValueError('Task needs id, prompt, bundle and verifier argv')
            forge.text(task['id'],'task ID',200);forge.text(task['prompt'],'task prompt');relative(task['bundle']);argv(task['verifier'])
            for field in ['repository','revision','family','source','purpose']:forge.text(task[field],f'task.{field}',1000)
            if task['purpose'] not in {'training','evaluation'} or task['source'].lower() not in {'forge',*forge.BENCHMARKS} or not re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}',task['revision']):raise ValueError('Invalid task provenance')
            if task['id'] in ids: raise ValueError('Duplicate selected task ID')
            ids.add(task['id']);key=hashlib.sha256(task['id'].encode()).hexdigest()[:24]
            folder=inputs/key;folder.mkdir(mode=0o700)
            bundle_hash=snapshot(source_in(suite_path.parent,task['bundle']),folder/'bundle')
            if not (folder/'bundle/seed').is_dir() or not (folder/'bundle/verify').is_dir(): raise ValueError('Bundle requires seed and verify directories')
            forge.write_new(folder/'task.json',{'id':task['id'],'prompt':task['prompt'],'runtime':suite['runtime']})
            tasks.append({**task,'key':key,'snapshot_sha256':bundle_hash})
        config={'format':1,'run_id':str(uuid.uuid4()),'attempt_budget':1,'image':image,'timeout_seconds':timeout,'cpus':2,'memory':'8g','adapter':suite['adapter'],'adapter_sha256':adapter_hash,'runtime':suite['runtime'],'tasks':tasks}
        # Validate exact runtime pins using the same experience schema.
        for k,v in config['runtime'].items():
            if k not in {'host','run','link','harness','model_sha256'} or not isinstance(v,str) or not re.fullmatch('[a-f0-9]{64}' if k=='model_sha256' else '[a-f0-9]{40}',v): raise ValueError('Pin all runtime identities')
        if set(config['runtime'])!={'host','run','link','harness','model_sha256'}: raise ValueError('Missing runtime identity')
        config['config_sha256']=forge.digest(config)
        (output/'results').mkdir(mode=0o700)
        forge.write_new(output/'run.json',config)
        return config
    except BaseException:
        shutil.rmtree(output);raise

@contextlib.contextmanager
def ownership(root):
    path=Path(root)/'.owner.lock'
    if path.is_symlink():raise ValueError('Unsafe run lock')
    fd=os.open(path,os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)
    try:
        if os.fstat(fd).st_nlink!=1: raise ValueError('Unsafe run lock')
        if os.fstat(fd).st_size==0:os.write(fd,b'0')
        os.lseek(fd,0,os.SEEK_SET)
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(fd,msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield
    finally:os.close(fd)

def docker_prefix():
    endpoint='npipe:////./pipe/docker_engine' if os.name=='nt' else 'unix:///var/run/docker.sock'
    return ['docker','--host',endpoint]

def command(config,name,mounts,args):
    result=[*docker_prefix(),'run','--pull','never','--rm','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--cpus',str(config['cpus']),'--memory',config['memory'],'--memory-swap',config['memory'],'--user',f'{getattr(os,"getuid",lambda:1000)()}:{getattr(os,"getgid",lambda:1000)()}','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,mode=1777','--tmpfs','/workspace:rw,nosuid,size=256m,mode=1777','--workdir','/workspace','--env','PYTHONDONTWRITEBYTECODE=1']
    for source,target in mounts:
        source=str(Path(source).resolve())
        if ',' in source or '\n' in source or '\r' in source:raise ValueError('Docker mount paths cannot contain commas or line breaks')
        result.extend(['--mount',f'type=bind,src={source},dst={target},readonly'])
    return [*result,'--entrypoint',args[0],config['image'],*args[1:]]

def execute(args,timeout,name):
    process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,shell=False)
    buffers=[bytearray(),bytearray()];overflow=threading.Event()
    def read(stream,index,limit):
        while True:
            data=stream.read(8192)
            if not data:return
            if len(buffers[index])+len(data)>limit:overflow.set();process.kill();return
            buffers[index].extend(data)
    threads=[threading.Thread(target=read,args=(process.stdout,0,forge.LIMIT),daemon=True),threading.Thread(target=read,args=(process.stderr,1,65536),daemon=True)]
    for thread in threads:thread.start()
    timed_out=False
    try:
        try:process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:timed_out=True;process.kill();process.wait(timeout=5)
    finally:
        # Killing the CLI alone does not guarantee its container exits.
        try:
            subprocess.run([*docker_prefix(),'rm','--force',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
        finally:
            if process.poll() is None:process.kill();process.wait(timeout=5)
            for thread in threads:thread.join(timeout=5)
            process.stdout.close();process.stderr.close()
    if overflow.is_set():raise ValueError('Container output exceeded its bounded capture budget')
    if timed_out:raise TimeoutError('Task container timed out')
    return process.returncode,bytes(buffers[0]),bytes(buffers[1])

def config_for(root):
    config=forge.read_json(Path(root)/'run.json');original=config.pop('config_sha256')
    if forge.digest(config)!=original:raise ValueError('Run configuration changed; create a new run')
    config['config_sha256']=original
    return config

def summary(root):
    root=Path(root);config=config_for(root);counts=collections.Counter()
    for task in config['tasks']:
        path=root/'results'/f'{task["key"]}.json'
        if not path.exists():counts['pending']+=1;continue
        value=forge.read_json(path)
        if value.get('task_id')!=task['id'] or value.get('config_sha256')!=config['config_sha256'] or value.get('status') not in STATUSES:raise ValueError('Result identity mismatch')
        if value['status'] in {'passed','failed'}:
            folder=root/'results'/task['key']
            for filename,key in [('prediction.json','prediction_sha256'),('verifier.json','verifier_sha256')]:
                report=folder/filename
                forge.read_json(report)
                if hashlib.sha256(report.read_bytes()).hexdigest()!=value['reports'].get(key):raise ValueError('Grading receipt changed')
            grade=forge.read_json(folder/'verifier.json')
            passed=value.get('verifier_exit_code')==0 and grade.get('passed') is True and bool(grade.get('checks')) and all(c.get('passed') is True for c in grade['checks'])
            if (value['status']=='passed')!=passed:raise ValueError('Result status disagrees with grading receipt')
        counts[value['status']]+=1
    return {'run_id':config['run_id'],'selected_tasks':len(config['tasks']),'attempt_budget':1,'counts':dict(counts),'scope':'Forge task receipts; not official HumanEval/SWE scoring. No rate reported before complete grading.'}

def run(root,executor=execute):
    root=Path(root).resolve();config=config_for(root)
    with ownership(root):
        if snapshot_hash(root/'inputs/adapter')!=config['adapter_sha256']:raise ValueError('Adapter snapshot changed; create a new run')
        for task in config['tasks']:
            folder=root/'inputs'/task['key']
            if snapshot_hash(folder/'bundle')!=task['snapshot_sha256'] or forge.read_json(folder/'task.json')!={'id':task['id'],'prompt':task['prompt'],'runtime':config['runtime']}:raise ValueError('Task snapshot changed; create a new run')
        for task in config['tasks']:
            result=root/'results'/f'{task["key"]}.json';claim=root/'results'/f'{task["key"]}.claim.json'
            if result.exists():continue
            names=[f'forge-{config["run_id"]}-{task["key"]}-{phase}' for phase in ['agent','verify']]
            value={'task_id':task['id'],'config_sha256':config['config_sha256'],'attempt':1,'status':'incomplete','reports':{}}
            if claim.exists():
                old=forge.read_json(claim)
                if old.get('task_id')!=task['id'] or old.get('config_sha256')!=config['config_sha256']:raise ValueError('Attempt claim identity mismatch')
                for name in names:subprocess.run([*docker_prefix(),'rm','--force',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
                value['reason']='Interrupted attempt retained; no automatic retry'
                forge.write_new(result,value);continue
            forge.write_new(claim,{'task_id':task['id'],'config_sha256':config['config_sha256'],'started':time.time()})
            folder=root/'inputs'/task['key'];reports=root/'results'/task['key'];reports.mkdir(mode=0o700)
            try:
                rc,raw,err=executor(command(config,names[0],[(root/'inputs/adapter','/adapter'),(folder/'bundle/seed','/seed'),(folder/'task.json','/input/task.json')],config['adapter']),config['timeout_seconds'],names[0])
                write_bytes_new(reports/'agent.stdout',raw);write_bytes_new(reports/'agent.stderr',err)
                if rc:raise ValueError(f'Agent adapter exited {rc}')
                prediction=json.loads(raw.decode('utf8'));files=prediction.get('files')
                if prediction.get('runtime')!=config['runtime']:raise ValueError('Adapter runtime identity mismatch')
                if not isinstance(files,dict) or not files or len(files)>1000:raise ValueError('Adapter must return a bounded files object')
                candidate=reports/'candidate';candidate.mkdir(mode=0o700);total=0
                for name,content in files.items():
                    relative(name)
                    if not isinstance(content,str):raise ValueError('Candidate files must contain UTF-8 text')
                    data=content.encode('utf8');total+=len(data)
                    if len(data)>262144 or total>1048576:raise ValueError('Candidate exceeds file budget')
                    path=candidate/name;path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.write_bytes(data);path.chmod(0o600)
                forge.write_new(reports/'prediction.json',prediction)
                value['reports']['prediction_sha256']=hashlib.sha256((reports/'prediction.json').read_bytes()).hexdigest()
                rc,raw,err=executor(command(config,names[1],[(candidate,'/candidate'),(folder/'bundle/verify','/verify')],task['verifier']),config['timeout_seconds'],names[1])
                value['verifier_exit_code']=rc
                write_bytes_new(reports/'verifier.stdout',raw);write_bytes_new(reports/'verifier.stderr',err)
                grade=json.loads(raw.decode('utf8'))
                checks=grade.get('checks')
                if rc in {125,126,127} or not isinstance(grade.get('passed'),bool) or not isinstance(checks,list) or not 1<=len(checks)<=10000 or any(not isinstance(c,dict) or not isinstance(c.get('passed'),bool) or not isinstance(c.get('name'),str) or not c['name'].strip() or len(c['name'])>1000 for c in checks):raise ValueError('Verifier did not return a valid grading receipt')
                forge.write_new(reports/'verifier.json',grade)
                value['reports']['verifier_sha256']=hashlib.sha256((reports/'verifier.json').read_bytes()).hexdigest()
                value['status']='passed' if rc==0 and grade['passed'] and all(c['passed'] for c in checks) else 'failed'
                value['experience_status']='not_supplied'
                if 'messages' in prediction or 'events' in prediction:
                    try:
                        if prediction['messages'][0]['content']!=task['prompt']:raise ValueError('Experience prompt does not match selected task')
                        payload={'format':1,'task':{k:task[k] for k in ['id','repository','revision','family','source','purpose']},'runtime':config['runtime'],'messages':prediction['messages'],'events':[*prediction['events'],{'kind':'test','text':f"Trusted verifier receipt {value['reports']['verifier_sha256']}; outcome {value['status']}"}],'outcome':{'status':value['status'],'report_sha256':value['reports']['verifier_sha256'],'verifier':f"Pinned image {config['image']}; argv {json.dumps(task['verifier'])}"}}
                        forge.write_new(reports/'experience.pending.json',forge.record(payload))
                        value['experience_status']='pending_review'
                    except (ValueError,TypeError,KeyError,IndexError) as error:
                        value['experience_status']='review_blocked';value['experience_reason']=str(error)[:500]
            except TimeoutError as error:value['status']='incomplete';value['reason']=str(error)
            except (OSError,ValueError,TypeError,subprocess.SubprocessError) as error:value['status']='infrastructure_error';value['reason']=str(error)[:1000]
            forge.write_new(result,value)
    return summary(root)

def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='operation',required=True)
    p=sub.add_parser('plan');p.add_argument('--suite',required=True);p.add_argument('--output',required=True);p.add_argument('--image',required=True);p.add_argument('--timeout',type=int,default=300)
    for name in ['run','summary']:p=sub.add_parser(name);p.add_argument('--run',required=True)
    args=parser.parse_args()
    try:
        result=plan(args.suite,args.output,args.image,args.timeout) if args.operation=='plan' else run(args.run) if args.operation=='run' else summary(args.run)
        print(json.dumps(result,indent=2))
    except (ValueError,OSError,TypeError) as error:parser.exit(2,f'Forge: {error}\n')
if __name__=='__main__':main()
