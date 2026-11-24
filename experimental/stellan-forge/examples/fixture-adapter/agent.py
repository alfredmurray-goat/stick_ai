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
print(json.dumps({'runtime':request['runtime'],'files':{'solution.py':'def add(a, b):\n    return a + b\n'},'messages':[{'role':'user','content':request['prompt']},{'role':'assistant','content':'<done>Synthetic fixture correction</done>'}],'events':[{'kind':'correction','text':'Synthetic adapter returns the known fixture correction; no model used.'}]}))
