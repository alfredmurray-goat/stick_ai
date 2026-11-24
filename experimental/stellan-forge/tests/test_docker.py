"""Optional real-container synthetic harness smoke. No model or benchmark score."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).parents[1]))
import runner
import forge
@unittest.skipUnless(os.environ.get('STELLAN_FORGE_IMAGE'),'Explicit local pinned fixture image required')
class DockerSmoke(unittest.TestCase):
    def test_isolated_fixture_grading_and_review_handoff(self):
        with tempfile.TemporaryDirectory(prefix='forge-docker-smoke-') as folder:
            root=Path(folder)/'run'
            config=runner.plan(Path(__file__).parents[1]/'examples/task-suite.json',root,os.environ['STELLAN_FORGE_IMAGE'],120)
            result=runner.run(root)
            self.assertEqual(result['counts'],{'passed':1,'failed':1})
            record=forge.read_json(root/'results'/config['tasks'][0]['key']/'experience.pending.json')
            self.assertEqual(record['review']['decision'],'pending')
            self.assertEqual(record['payload']['task']['purpose'],'evaluation')
            reviewed=forge.review_record(record,'approved','synthetic CI reviewer','Harness check, no model was run')
            manifest=forge.export_dataset([reviewed],Path(folder)/'dataset',{'task_ids':[],'groups':[]})
            self.assertEqual(manifest['files']['train.jsonl']['rows'],0)
            again=runner.run(root);self.assertEqual(again,result)
            containers=subprocess.check_output([*runner.docker_prefix(),'ps','--all','--quiet','--filter',f'name=forge-{config["run_id"]}'],text=True)
            self.assertEqual(containers.strip(),'')
if __name__=='__main__':unittest.main()
