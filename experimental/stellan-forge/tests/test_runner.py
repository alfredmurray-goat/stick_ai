import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).parents[1]
sys.path.insert(0,str(ROOT))
import runner
import forge
class RunnerTests(unittest.TestCase):
    def setup_run(self,folder,tasks=2):
        root=Path(folder);(root/'adapter').mkdir();(root/'adapter/agent.py').write_text('# fixture')
        (root/'task/seed').mkdir(parents=True);(root/'task/seed/solution.py').write_text('wrong')
        (root/'task/verify').mkdir();(root/'task/verify/check.py').write_text('# trusted fixture')
        suite={'format':1,'runtime':{**{k:'a'*40 for k in ['host','run','link','harness']},'model_sha256':'b'*64},'adapter_dir':'adapter','adapter':['python','/adapter/agent.py'],'tasks':[{'id':f'task-{i}','prompt':f'fixture {i}','bundle':'task','verifier':['python','/verify/check.py'],'repository':'fixture/repo','revision':'a'*40,'family':f'task-{i}','source':'forge','purpose':'evaluation'} for i in range(tasks)]}
        (root/'suite.json').write_text(json.dumps(suite));output=root/'run'
        config=runner.plan(root/'suite.json',output,'fixture@sha256:'+'a'*64)
        return output,config
    def test_one_attempt_grading_and_resume_without_replay(self):
        with tempfile.TemporaryDirectory() as folder:
            output,config=self.setup_run(folder)
            calls=[]
            def execute(command,timeout,name):
                calls.append(name)
                data={'files':{'solution.py':'correct fixture'}} if name.endswith('-agent') else {'passed':True,'checks':[{'name':'fixture','passed':True}]}
                if name.endswith('-agent'):data['runtime']=config['runtime']
                return 0,json.dumps(data).encode(),b''
            result=runner.run(output,execute)
            self.assertEqual(result['selected_tasks'],2);self.assertEqual(result['counts'],{'passed':2});self.assertEqual(len(calls),4)
            runner.run(output,execute);self.assertEqual(len(calls),4)
            receipt=output/'results'/config['tasks'][0]['key']/'verifier.json';receipt.write_text('{}')
            with self.assertRaisesRegex(ValueError,'changed'):runner.summary(output)
    def test_verifier_failure_keeps_denominator(self):
        with tempfile.TemporaryDirectory() as folder:
            output,config=self.setup_run(folder)
            def execute(command,timeout,name):
                data={'files':{'solution.py':'wrong'}} if name.endswith('-agent') else {'passed':False,'checks':[{'name':'test','passed':False}]}
                if name.endswith('-agent'):data['runtime']=config['runtime']
                return 0,json.dumps(data).encode(),b''
            result=runner.run(output,execute)
            self.assertEqual(result['selected_tasks'],2);self.assertEqual(result['counts'],{'failed':2})
            config=runner.config_for(output);path=output/'results'/f"{config['tasks'][0]['key']}.json"
            changed=json.loads(path.read_text());changed['status']='passed';path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError,'disagrees'):runner.summary(output)
    def test_snapshot_mutation_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            output,config=self.setup_run(folder)
            path=output/'inputs'/config['tasks'][0]['key']/'bundle/verify/check.py';path.write_text('changed verifier')
            with self.assertRaisesRegex(ValueError,'snapshot changed'):runner.run(output,lambda *args:self.fail('must not execute'))
    def test_interrupted_claim_is_not_retried(self):
        with tempfile.TemporaryDirectory() as folder:
            output,config=self.setup_run(folder,tasks=1);task=config['tasks'][0]
            forge.write_new(output/'results'/f'{task["key"]}.claim.json',{'task_id':task['id'],'config_sha256':config['config_sha256']})
            with patch.object(runner.subprocess,'run') as cleanup:
                result=runner.run(output,lambda *args:self.fail('must not retry'))
                self.assertEqual(cleanup.call_count,2)
            self.assertEqual(result['counts'],{'incomplete':1})
    def test_mounts_are_readonly_and_no_remote_or_pull(self):
        with tempfile.TemporaryDirectory() as folder:
            output,config=self.setup_run(folder)
            command=runner.command(config,'fixture',[(output,'/input')],['python','test.py'])
            for value in ['--read-only','--network','none','--cap-drop','ALL','--pull','never','--user','--pids-limit']:self.assertIn(value,command)
            self.assertIn('readonly',next(v for v in command if v.startswith('type=bind')))
            self.assertNotIn('DOCKER_HOST',command);self.assertTrue(command[2].startswith(('unix:','npipe:')))
            with self.assertRaises(ValueError):runner.relative('../escape')
            with self.assertRaises(ValueError):runner.relative('C:/escape')
    def test_timeout_and_infrastructure_remain_visible(self):
        with tempfile.TemporaryDirectory() as folder:
            output,config=self.setup_run(folder)
            def execute(command,timeout,name):
                if 'task-does-not-exist' in name:raise AssertionError()
                raise TimeoutError('fixture timeout')
            result=runner.run(output,execute);self.assertEqual(result['counts'],{'incomplete':2})
    def test_verifier_receipt_feeds_pending_review_not_automatic_training(self):
        with tempfile.TemporaryDirectory() as folder:
            output,config=self.setup_run(folder,tasks=1)
            def execute(command,timeout,name):
                data={'files':{'solution.py':'correct'},'runtime':config['runtime'],'messages':[{'role':'user','content':'fixture 0'},{'role':'assistant','content':'<done>fixture</done>'}],'events':[]} if name.endswith('-agent') else {'passed':True,'checks':[{'name':'check','passed':True}]}
                return 0,json.dumps(data).encode(),b''
            runner.run(output,execute)
            record=forge.read_json(output/'results'/config['tasks'][0]['key']/'experience.pending.json')
            self.assertEqual(record['review']['decision'],'pending')
            self.assertEqual(record['payload']['outcome']['status'],'passed')
            self.assertEqual(record['payload']['events'][-1]['kind'],'test')
if __name__=='__main__':unittest.main()
