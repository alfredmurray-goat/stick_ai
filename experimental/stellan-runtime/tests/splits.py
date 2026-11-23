import hashlib
import json
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
import models

class SplitTests(unittest.TestCase):
    def test_split_sessions_match_single_models_and_reject_bad_parts(self):
        for architecture in ['mamba2', 'llama']:
            fixture = models.Fixture(architecture)
            tensors = fixture.tensors
            def flags(index, count):
                return [('split.no',2,struct.pack('<H',index)),('split.count',2,struct.pack('<H',2)),('split.tensors.count',5,struct.pack('<i',count))]
            primary = models.model(tensors[:3],fixture.metadata+flags(0,len(tensors)))
            rest = models.model(tensors[3:],flags(1,len(tensors)))
            with tempfile.TemporaryDirectory() as temp:
                root=Path(temp);whole=root/'whole.gguf';first=root/'first é.gguf';second=root/'rest é.gguf'
                whole.write_bytes(fixture.bytes());first.write_bytes(primary);second.write_bytes(rest)
                def invoke(path, extra=[]):
                    return subprocess.run([models.EXECUTABLE,'serve',str(path),hashlib.sha256(path.read_bytes()).hexdigest(),'2','128',*extra],input='1 3 1,68\n',text=True,capture_output=True,timeout=15)
                original=invoke(whole);split=invoke(first,['--split',str(second),hashlib.sha256(rest).hexdigest()])
                self.assertEqual(split.returncode,0,split.stderr)
                ids=lambda result:[e['id'] for line in result.stdout.splitlines() if (e:=json.loads(line))['event']=='token']
                self.assertEqual(ids(original),ids(split));self.assertEqual(len(ids(split)),3)
                self.assertNotEqual(invoke(first).returncode,0)
                self.assertNotEqual(invoke(first,['--split',str(second),'0'*64]).returncode,0)
                bad=models.model(tensors[3:],flags(0,len(tensors)));second.write_bytes(bad)
                self.assertNotEqual(invoke(first,['--split',str(second),hashlib.sha256(bad).hexdigest()]).returncode,0)

if __name__=='__main__':unittest.main()
