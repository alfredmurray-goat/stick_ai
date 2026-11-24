"""Synthetic adapter for harness tests. It does not run a model."""
import json
from pathlib import Path
request=json.loads(Path('/input/task.json').read_text())
assert not Path('/verify').exists(), 'Verifier inputs must not be exposed to the agent'
try:
    Path('/seed/solution.py').write_text('must not write')
except OSError:
    pass
else:
    raise AssertionError('Seed mount must be read-only')
code='def broken(:\n' if request['prompt']=='synthetic-bad-syntax' else 'def add(a, b):\n    return a + b\n'
print(json.dumps({'runtime':request['runtime'],'files':{'solution.py':code},'messages':[{'role':'user','content':request['prompt']},{'role':'assistant','content':'<done>Synthetic fixture candidate</done>'}],'events':[{'kind':'action','text':'Synthetic adapter returns a fixture candidate; no model used.'}]}))
