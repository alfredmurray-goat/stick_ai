import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import argparse
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bench', Path(__file__).parents[1] / 'scripts/benchmark-swe.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)

class BenchmarkTests(unittest.TestCase):
    def test_resume_rebuilds_missing_export_without_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'task.json').write_text(json.dumps(dict(instance_id='task', model_name_or_path='stellan-1-max', model_patch='')))
            target = root / 'predictions.jsonl'
            bench.export_predictions([{'instance_id': 'task'}], root, target)
            result = json.loads(target.read_text())
            self.assertEqual(result['model_patch'], '')
            self.assertEqual(set(result), {'instance_id', 'model_name_or_path', 'model_patch'})

    def test_rejects_remote_endpoint(self):
        with self.assertRaisesRegex(ValueError, 'local HTTP'):
            bench.completion('https://example.com', 'm', [], 1, 1)

    def test_context_uses_only_pinned_regular_source_blobs(self):
        calls = []
        def fake_git(repo, *args):
            calls.append(args)
            if args[0] == 'cat-file' and args[1] == '-e':
                return b''
            if args[0] == 'ls-tree':
                return b'100644 blob aaa\tsrc.py\x00120644 blob bbb\tlink.py\x00100644 blob ccc\ttests/test_answer.py\x00'
            if args[:2] == ('cat-file', '-s'):
                return b'12'
            if args[:2] == ('cat-file', 'blob'):
                self.assertEqual(args[2], 'aaa')
                return b'def bug(): pass'
            raise AssertionError(args)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / 'owner__repo').mkdir()
            with patch.object(bench, 'git', fake_git):
                text, paths = bench.context(dict(repo='owner/repo', base_commit='a'*40, problem_statement='bug'), root, 100)
            self.assertEqual(paths, ['src.py'])
            self.assertIn('def bug()', text)
            self.assertIn(('ls-tree', '-rz', '--full-tree', 'a'*40), calls)

    def test_inference_resume_and_changed_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            tasks = root / 'tasks.jsonl'
            task = dict(instance_id='owner__repo-1', repo='owner/repo', base_commit='a'*40, problem_statement='bug')
            tasks.write_text(json.dumps(task) + '\n')
            binary = root / 'server'; binary.write_bytes(b'server')
            model = root / 'model'; model.write_bytes(b'model')
            args = argparse.Namespace(tasks=str(tasks), out=str(root / 'out'), cache=str(root / 'cache'),
                    model='stellan-1-max', context_chars=100, max_tokens=20, server_bin=str(binary),
                    gguf=str(model), endpoint='http://127.0.0.1:18100', timeout=1)
            response = {'choices': [{'message': {'content': 'No solution'}}]}
            with patch.object(bench, 'context', return_value=('source', ['src.py'])), patch.object(bench, 'completion', return_value=response) as complete:
                bench.run(args)
                (root / 'out' / 'predictions.jsonl').unlink()
                bench.run(args)
                self.assertEqual(complete.call_count, 1)
            exported = json.loads((root / 'out' / 'predictions.jsonl').read_text())
            self.assertEqual(exported['model_patch'], '')
            self.assertNotIn('passed', exported)
            args.max_tokens = 21
            with self.assertRaisesRegex(ValueError, 'settings changed'):
                bench.run(args)

    def test_patch_extraction_keeps_model_failure_empty(self):
        self.assertEqual(bench.extract_patch('Sorry, no patch'), '')
        self.assertEqual(bench.extract_patch('```diff\ndiff --git a/a b/a\n```'), 'diff --git a/a b/a\n')

if __name__ == '__main__':
    unittest.main()
