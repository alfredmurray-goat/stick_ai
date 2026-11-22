import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('grade', Path(__file__).parents[1] / 'scripts/grade-swe.py')
grade = importlib.util.module_from_spec(spec); spec.loader.exec_module(grade)

class GradingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.ids = [f'owner__repo-{n}' for n in range(10)]
        manifest = self.root / 'swe-tasks.jsonl'
        manifest.write_text(''.join(json.dumps(dict(instance_id=id_)) + '\n' for id_ in self.ids))
        grade.write(str(manifest) + '.meta.json', dict(sha256=grade.digest(manifest), count=10, dataset=grade.DATASET, revision="c104f840cc67f8b6eec6f759ebc8b2693d585d4a"))
        for model in grade.MODELS:
            p = self.root / f'swe-{model}' / 'predictions.jsonl'; p.parent.mkdir()
            p.write_text(''.join(json.dumps(dict(instance_id=id_, model_name_or_path=model, model_patch='')) + '\n' for id_ in self.ids))
        self.reports = self.root / 'reports'; self.reports.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def receipt(self, model, id_, status):
        grade.write(self.reports / f'{model}-{id_}.json', dict(model=model, instance_id=id_, status=status,
                    harnessCommit=grade.HARNESS_SHA, manifestSha256=grade.digest(self.root / 'swe-tasks.jsonl')))

    def test_plan_has_twenty_independent_tasks(self):
        rows = grade.plan(self.root)['include']; self.assertEqual(len(rows), 20)
        self.assertEqual(len({(r['model'], r['instance']) for r in rows}), 20)

    def test_manifest_tampering_is_rejected(self):
        with (self.root / 'swe-tasks.jsonl').open('a') as f: f.write('\n')
        with self.assertRaisesRegex(ValueError, 'receipt'): grade.plan(self.root)

    def test_empty_model_answers_remain_in_denominator(self):
        for model in grade.MODELS:
            for n, id_ in enumerate(self.ids): self.receipt(model, id_, 'resolved' if n == 0 else 'empty_patch')
        result = grade.aggregate(self.root, self.reports)
        for row in result['models'].values():
            self.assertEqual(row['denominator'], 10); self.assertEqual(row['passAt1'], 0.1)
            self.assertEqual(row['empty_patch'], 9)

    def test_infrastructure_and_missing_reports_prevent_pass_at_one(self):
        self.receipt(grade.MODELS[0], self.ids[0], 'infrastructure_error')
        result = grade.aggregate(self.root, self.reports)
        for row in result['models'].values():
            self.assertFalse(row['gradingComplete']); self.assertIsNone(row['passAt1'])
            self.assertEqual(row['denominator'], 10)

    def test_rejects_duplicate_predictions(self):
        p = self.root / 'swe-stellan-1-lite' / 'predictions.jsonl'
        p.write_text(p.read_text() + p.read_text().splitlines()[0] + '\n')
        with self.assertRaisesRegex(ValueError, 'duplicate'): grade.plan(self.root)

    def test_only_scoped_prediction_is_submitted_to_official_harness(self):
        from types import SimpleNamespace
        args = SimpleNamespace(submission=self.root, model=grade.MODELS[0], instance=self.ids[0], run_id='test', out=str(self.root / 'out'), harness='/missing')
        grade.task(args)
        receipt = json.loads(next((self.root / 'out').glob('stellan-1-*.json')).read_text())
        self.assertEqual(receipt['status'], 'empty_patch')
        self.assertFalse((self.root / 'out' / 'command.json').exists())

    def test_official_report_and_infrastructure_precedence(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        model = grade.MODELS[0]; id_ = self.ids[0]
        prediction = self.root / f'swe-{model}' / 'predictions.jsonl'
        prediction.write_text(json.dumps(dict(instance_id=id_, model_name_or_path=model, model_patch='diff --git a/a b/a\n')) + '\n')
        for infra in (False, True):
            out = self.root / ('infra' if infra else 'resolved')
            args = SimpleNamespace(submission=self.root, model=model, instance=id_, run_id='run', out=str(out), harness=str(self.root))
            def fake_run(command, **kwargs):
                if command[:2] == ['docker', 'info']:
                    return SimpleNamespace(stdout='Docker test fixture', returncode=0)
                if 'swebench.harness.run_evaluation' in command:
                    self.assertNotIn('gold', command)
                    self.assertEqual(command[command.index('--max_workers') + 1], '1')
                    grade.write(out / 'logs/evaluation/run/results.json', dict(resolved_ids=[id_], infra_failure_ids=[id_] if infra else []))
                return SimpleNamespace(returncode=0)
            with patch.object(grade.shutil, 'disk_usage', return_value=SimpleNamespace(free=100*1024**3)), patch.object(grade.subprocess, 'check_output', return_value=grade.HARNESS_SHA + '\n'), patch.object(grade.subprocess, 'run', side_effect=fake_run), patch.object(grade, 'evaluation_dataset', return_value=out / 'dataset.json'):
                grade.task(args)
            receipt = json.loads((out / f'{model}-{id_}.json').read_text())
            self.assertEqual(receipt['status'], 'infrastructure_error' if infra else 'resolved')
            self.assertEqual(receipt['resolved'], not infra)

if __name__ == '__main__': unittest.main()
