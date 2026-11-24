import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('forge',Path(__file__).parents[1]/'forge.py')
forge=importlib.util.module_from_spec(spec);spec.loader.exec_module(forge)
def payload(family='group',status='passed'):
    return {'format':1,'task':{'id':family,'repository':'fixture/repo','revision':'a'*40,'family':family,'source':'forge','purpose':'training'},'runtime':{**{k:'a'*40 for k in ['host','run','link','harness']},'model_sha256':'b'*64},'messages':[{'role':'user','content':family},{'role':'assistant','content':'<done>Verified fixture correction</done>'}],'events':[{'kind':'test','text':'trusted fixture report retained'}],'outcome':{'status':status,'report_sha256':'c'*64,'verifier':'test fixture; not a model benchmark'}}
def approved(p):return forge.review_record(forge.record(p),'approved','fixture reviewer','reviewed synthetic fixture')
class ForgeTests(unittest.TestCase):
    def test_review_integrity_and_secret_rejection(self):
        value=approved(payload());value['payload']['messages'][1]['content']='changed'
        with self.assertRaisesRegex(ValueError,'changed'):forge.validate_record(value)
        p=payload();p['messages'][0]['content']='Authorization: Bearer secret-value'
        with self.assertRaisesRegex(ValueError,'credential'):forge.record(p)
    def test_pending_failed_and_evaluation_never_train(self):
        values=[forge.record(payload('pending')),approved(payload('failed','failed'))]
        p=payload('HumanEval/0');p['task']['source']='humaneval';values.append(approved(p))
        with tempfile.TemporaryDirectory() as folder:
            result=forge.export_dataset(values,Path(folder)/'export',{'task_ids':[],'groups':[]})
            self.assertEqual(result['counts'].get('exported',0),0)
            self.assertEqual(sum(result['counts'].values()),3)
    def test_task_family_group_is_stable(self):
        first=payload();second=payload();second['task']['id']='different-attempt'
        self.assertEqual(forge.group_for(first),forge.group_for(second))
        self.assertEqual(forge.split_for(forge.group_for(first)),forge.split_for(forge.group_for(second)))
    def test_content_matching_evaluation_is_excluded(self):
        p=payload('training');e=copy.deepcopy(p);e['task']['id']='held-out';e['task']['purpose']='evaluation'
        with tempfile.TemporaryDirectory() as folder:
            result=forge.export_dataset([approved(p),approved(e)],Path(folder)/'out',{'task_ids':[],'groups':[]})
            self.assertEqual(result['counts'].get('exported',0),0)
    def test_evaluation_prompt_with_a_different_answer_is_excluded(self):
        p=payload('train');e=copy.deepcopy(p);e['task']['id']='eval';e['task']['purpose']='evaluation';e['messages'][1]['content']='Different answer to the same held-out prompt'
        with tempfile.TemporaryDirectory() as folder:
            result=forge.export_dataset([approved(p),approved(e)],Path(folder)/'out',{'task_ids':[],'groups':[]})
            self.assertEqual(result['counts'].get('exported',0),0)
    def test_export_manifest_and_refuse_overwrite(self):
        values=[approved(payload(f'group-{i}')) for i in range(30)]
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder)/'export';manifest=forge.export_dataset(values,out,{'task_ids':[],'groups':[]})
            self.assertGreater(manifest['counts'].get('exported',0),0)
            for name,info in manifest['files'].items():
                import hashlib
                self.assertEqual(hashlib.sha256((out/name).read_bytes()).hexdigest(),info['sha256'])
            with self.assertRaises(FileExistsError):forge.export_dataset(values,out,{'task_ids':[],'groups':[]})
    def test_raw_record_and_review_cannot_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'record.json';forge.write_new(path,forge.record(payload()))
            with self.assertRaises(FileExistsError):forge.write_new(path,approved(payload()))
            self.assertEqual(forge.read_json(path)['review']['decision'],'pending')
    def test_review_selection_conflicts_and_memory_budget(self):
        raw=forge.record(payload());reviewed=approved(payload())
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder)/'out'
            result=forge.export_dataset(iter([raw,reviewed]),out,{'task_ids':[],'groups':[]})
            self.assertEqual(result['selected_records'],1)
            self.assertNotIn('not_approved',result['counts'])
            denied=forge.review_record(raw,'rejected','other reviewer','denied')
            with self.assertRaisesRegex(ValueError,'Conflicting'):
                forge.export_dataset([reviewed,denied],Path(folder)/'bad',{'task_ids':[],'groups':[]})
            old=forge.EXPORT_LIMIT
            try:
                forge.EXPORT_LIMIT=10
                with self.assertRaisesRegex(ValueError,'memory budget'):
                    forge.export_dataset([reviewed],Path(folder)/'large',{'task_ids':[],'groups':[]})
            finally:forge.EXPORT_LIMIT=old
    def test_error_correction_requires_later_verification(self):
        events=[{'kind':kind,'text':'fixture'} for kind in ['error','correction','test']]
        self.assertTrue(forge.corrected(events))
        self.assertFalse(forge.corrected(events+[{'kind':'error','text':'new failure'}]))
        self.assertFalse(forge.corrected(events[:2]))
    def test_real_cli_walkthrough_keeps_fixture_out_of_training(self):
        import subprocess,sys
        root=Path(__file__).parents[1]
        with tempfile.TemporaryDirectory() as folder:
            pending=Path(folder)/'pending.json';reviewed=Path(folder)/'reviewed.json';output=Path(folder)/'dataset'
            commands=[['record','--input',str(root/'examples/synthetic-experience.json'),'--output',str(pending)],['review','--input',str(pending),'--output',str(reviewed),'--decision','approved','--reviewer','test reviewer'],['export','--records',str(reviewed),'--holdout-manifest',str(root/'examples/holdout.json'),'--output',str(output)]]
            for args in commands:
                result=subprocess.run([sys.executable,str(root/'forge.py'),*args],capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
            manifest=json.loads((output/'manifest.json').read_text())
            self.assertEqual(manifest['counts']['evaluation_or_holdout'],1)
            self.assertEqual(manifest['files']['train.jsonl']['rows'],0)
            self.assertEqual(manifest['outcome_counts'],{'passed':1})
if __name__=='__main__':unittest.main()
