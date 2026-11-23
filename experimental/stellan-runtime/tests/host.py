"""Exercise the native backend without invoking Node or shell commands."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
RUNTIME, HOST = sys.argv[1:3]
from models import Fixture

class HostTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.model = Path(self.root.name) / 'native model é.gguf'
        self.data = Fixture('mamba2').bytes()
        self.model.write_bytes(self.data)
        self.digest = hashlib.sha256(self.data).hexdigest()

    def tearDown(self):
        self.root.cleanup()

    def invoke(self, lines, *options, digest=None):
        result = subprocess.run([HOST, str(self.model), digest or self.digest, '2', '128', *options], input=lines, capture_output=True, text=True, encoding='utf-8', timeout=15)
        return result, [json.loads(line) for line in result.stdout.splitlines()]

    def test_text_matches_token_ids_and_reset_discards_state(self):
        # SentencePiece fixture uses byte fallback; native text adds BOS and the space marker.
        text = 'A B'
        ids = [1] + [b + 3 for b in ('▁' + text.replace(' ', '▁')).encode()]
        result, events = self.invoke(f'status\n1 3 {text.encode().hex()}\nstatus\nreset\nstatus\n2 3 {text.encode().hex()}\nshutdown\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(events[0]['native_host'])
        self.assertEqual(events[0]['input_mode'], 'utf8-hex')
        states = [e for e in events if e['event'] == 'status']
        self.assertFalse(states[0]['node_required'])
        self.assertGreater(states[1]['cached_tokens'], 0)
        self.assertEqual(states[2]['cached_tokens'], 0)
        first = [e for e in events if e['event'] == 'token' and e['request_id'] == 1]
        second = [e for e in events if e['event'] == 'token' and e['request_id'] == 2]
        self.assertEqual([e['id'] for e in first], [e['id'] for e in second])
        for event in first:
            expected_bytes = bytes([event['id'] - 3]) if 3 <= event['id'] < 259 else b''
            self.assertEqual(bytes.fromhex(event['bytes_hex']), expected_bytes)
        reference = subprocess.run([RUNTIME, 'decode', str(self.model), self.digest, ','.join(map(str, ids)), '3', '2', '128'], capture_output=True, text=True, timeout=15, check=True)
        expected = [e['id'] for e in map(json.loads, reference.stdout.splitlines()) if e['event'] == 'token']
        self.assertEqual([e['id'] for e in first], expected)
        self.assertEqual(events[-1]['event'], 'stopped')

    def test_bad_input_is_bounded_and_session_recovers(self):
        invalid = ['0', 'zz', 'c0af', 'eda080', 'f4908080', 'f0808080', 'e282', 'ff']
        lines = ''.join(f'{i} 1 {value}\n' for i, value in enumerate(invalid, 1))
        result, events = self.invoke(lines + '9 1 41\nshutdown\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len([e for e in events if e['event'] == 'error']), len(invalid))
        self.assertEqual(len([e for e in events if e['event'] == 'token']), 1)
        result, events = self.invoke('1 1 ' + '41' * 1048577 + '\nshutdown\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('bounded', next(e['message'] for e in events if e['event'] == 'error'))

    def test_valid_unicode_and_embedded_newlines(self):
        prompt = 'æ 🦈\n日本語'
        result, events = self.invoke(f'1 2 {prompt.encode().hex()}\nshutdown\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse([e for e in events if e['event'] == 'error'])
        self.assertEqual(len([e for e in events if e['event'] == 'token']), 2)

    def test_integrity_and_explicit_max_mode(self):
        result, events = self.invoke('status\n', digest='0' * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(events)
        self.data = Fixture('llama', bpe=True).bytes()
        self.model.write_bytes(self.data)
        self.digest = hashlib.sha256(self.data).hexdigest()
        result, events = self.invoke('1 1 41\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--token-ids', result.stderr)
        result, events = self.invoke('1 2 1,68\nshutdown\n', '--token-ids')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]['input_mode'], 'token-ids')
        self.assertEqual(len([e for e in events if e['event'] == 'token']), 2)
        result, _ = self.invoke('', '--unknown')
        self.assertNotEqual(result.returncode, 0)

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])
