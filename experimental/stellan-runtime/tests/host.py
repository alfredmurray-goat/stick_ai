"""Exercise the native backend without invoking Node or shell commands."""
import hashlib
import os
import time
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
RUNTIME, HOST = sys.argv[1:3]
from models import Fixture, model

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
        result = subprocess.run([HOST, str(self.model), digest or self.digest, '2', '128', *options], input=lines.encode('utf-8'), capture_output=True, timeout=15)
        # Send exact protocol bytes: text-mode stdin expands CRLF twice on Windows.
        result.stdout = result.stdout.decode('utf-8')
        result.stderr = result.stderr.decode('utf-8')
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

    def test_idle_pipe_releases_the_process_without_closing_stdin(self):
        process = subprocess.Popen([HOST, str(self.model), self.digest, '2', '128'], env={**os.environ, 'STELLAN_HOST_IDLE_SECONDS':'1'}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            ready = json.loads(process.stdout.readline()); self.assertEqual(ready['event'], 'ready')
            process.wait(timeout=5)
            self.assertEqual(process.returncode, 0, process.stderr.read())
            events = [json.loads(line) for line in process.stdout.read().splitlines()]
            self.assertIn({'event':'rested','reason':'inactivity'}, events)
        finally:
            if process.poll() is None: process.kill(); process.wait(timeout=5)
            process.stdin.close(); process.stdout.close(); process.stderr.close()

    def test_signal_stops_an_idle_pipe_without_input(self):
        process = subprocess.Popen([HOST, str(self.model), self.digest, '2', '128'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            self.assertEqual(json.loads(process.stdout.readline())['event'], 'ready')
            process.terminate(); process.wait(timeout=5)
            if os.name != 'nt': self.assertEqual(process.returncode, 130)
        finally:
            if process.poll() is None: process.kill(); process.wait(timeout=5)
            process.stdin.close(); process.stdout.close(); process.stderr.close()

    def test_buffered_commands_crlf_and_invalid_timeout(self):
        result, events = self.invoke('status\r\nreset\r\nstatus\r\nshutdown\r\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([e['event'] for e in events], ['ready','status','reset','status','stopped'])
        self.assertEqual(events[1]['idle_timeout_seconds'], 600)
        for value in ['0','-1','86401','bad']:
            result = subprocess.run([HOST,str(self.model),self.digest,'2','128'],env={**os.environ,'STELLAN_HOST_IDLE_SECONDS':value},input='',capture_output=True,text=True,timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('timeout', result.stderr)

    def test_chunk_boundaries_and_line_limits(self):
        for size in [4095, 4096, 4097, 4194304]:
            result, events = self.invoke('x' * size + '\nstatus\r\nshutdown\n')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([e['event'] for e in events], ['ready', 'error', 'status', 'stopped'])
        result, _ = self.invoke('x' * 4194305 + '\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exceeds limit', result.stderr)

    def test_verified_split_host_matches_whole_model(self):
        command='1 2 '+b'A B'.hex()+'\nshutdown\n'
        original, reference=self.invoke(command)
        self.assertEqual(original.returncode,0,original.stderr)
        fixture=Fixture('mamba2');count=len(fixture.tensors)
        def flags(index):
            return [('split.no',2,struct.pack('<H',index)),('split.count',2,struct.pack('<H',2)),('split.tensors.count',5,struct.pack('<i',count))]
        first=model(fixture.tensors[:3],fixture.metadata+flags(0));rest=model(fixture.tensors[3:],flags(1))
        self.model.write_bytes(first);self.digest=hashlib.sha256(first).hexdigest()
        part=Path(self.root.name)/'rest é.gguf';part.write_bytes(rest)
        result, events=self.invoke(command,'--split',str(part),hashlib.sha256(rest).hexdigest())
        self.assertEqual(result.returncode,0,result.stderr)
        ids=lambda values:[e['id'] for e in values if e['event']=='token']
        self.assertEqual(ids(events),ids(reference));self.assertEqual(len(ids(events)),2)
        result,_=self.invoke(command,'--split',str(part),'0'*64)
        self.assertNotEqual(result.returncode,0)

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
