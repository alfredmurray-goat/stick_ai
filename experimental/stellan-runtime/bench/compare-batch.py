"""Retain alternating fresh-process timings; not a whole-model benchmark."""
import json,os,platform,statistics,subprocess,sys
binary,report=sys.argv[1:3]
untiled=len(sys.argv)>3 and sys.argv[3]=="untiled"
trials=[]
for trial in range(5):
 for scalar in ([True,False] if trial%2==0 else [False,True]):
  env={**os.environ};env.pop('STELLAN_RUNTIME_SCALAR',None);env.pop('STELLAN_RUNTIME_ARM_UNTILED',None)
  if scalar:env['STELLAN_RUNTIME_ARM_UNTILED' if untiled else 'STELLAN_RUNTIME_SCALAR']='1'
  result=subprocess.run([binary],env=env,capture_output=True,text=True,check=True,timeout=60)
  value=json.loads(result.stdout);assert value['scalar']==(scalar and not untiled)
  trials.append({'trial':trial,'baseline':scalar,**value})
medians=[]
for kind in [12,14]:
 for batch in [1,8,32]:
  matched=lambda scalar:[next(r for r in t['rows'] if r['type']==kind and r['batch']==batch) for t in trials if t['baseline']==scalar]
  old,new=matched(True),matched(False)
  for a,b in zip(old,new):assert abs(a['checksum']-b['checksum'])<=max(0.1,abs(a['checksum'])*0.0001),(a,b)
  before,after=statistics.median(r['ms'] for r in old),statistics.median(r['ms'] for r in new)
  medians.append({'type':kind,'batch':batch,'baselineMedianMs':before,'candidateMedianMs':after,'ratio':before/after})
receipt={'baseline':'previous NEON batch' if untiled else 'scalar','scope':'Synthetic single-row quantized batches, no model/agent or whole-app speed claim','machine':platform.machine(),'platform':platform.platform(),'trials':trials,'medians':medians}
with open(report,'x') as f:json.dump(receipt,f,indent=2);f.write('\n')
print(json.dumps({'machine':platform.machine(),'medians':medians}))
