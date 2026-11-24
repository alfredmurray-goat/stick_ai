"""Trusted fixture verifier, mounted separately from the agent stage."""
import importlib.util
import json
from pathlib import Path
try:
    Path('/candidate/solution.py').write_text('must not mutate candidate')
except OSError:
    pass
else:
    raise AssertionError('Candidate mount must be read-only')
spec=importlib.util.spec_from_file_location('solution','/candidate/solution.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
checks=[{'name':f'add({a},{b})','passed':module.add(a,b)==expected} for a,b,expected in [(2,3,5),(-4,1,-3),(0,0,0)]]
print(json.dumps({'passed':all(c['passed'] for c in checks),'checks':checks}))
