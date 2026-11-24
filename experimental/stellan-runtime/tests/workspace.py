"""Exercise the standalone native workspace service without Node or a model."""
import json, os, pathlib, subprocess, sys, tempfile

with tempfile.TemporaryDirectory(prefix='stellan-workspace-') as directory:
    root = pathlib.Path(directory)
    (root/'hello.txt').write_text('hello world', encoding='utf8')
    (root/'.stick').mkdir()
    (root/'.stick/secret').write_text('private')
    process = subprocess.Popen([sys.argv[1], '--workspace', str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf8')
    sequence = 0
    def receive():
        line = process.stdout.readline()
        assert line, process.stderr.read()
        return json.loads(line)
    def request(operation, *args, raw=False):
        global sequence
        sequence += 1
        payload = ' '.join(args if raw else [arg.encode('utf8').hex() or '-' for arg in args])
        process.stdin.write(f'{sequence} {operation} {payload}\n'); process.stdin.flush()
        result = receive()
        assert result['request_id'] == sequence, result
        return result
    def error(operation, *args, raw=False):
        result = request(operation, *args, raw=raw)
        assert result['event'] == 'error', result
    try:
        ready = receive()
        assert ready['scope'] == 'workspace-files' and ready['writes_require_approval']
        assert request('read_file', 'hello.txt')['text'] == 'hello world'
        assert request('list_dir', '.')['text'] == 'hello.txt'
        assert request('list_dir', '.')['text'] == 'hello.txt'
        for name in ['../outside', '/etc/passwd', '.stick/secret', 'C:\\outside']:
            error('read_file', name)
        change = request('write_file', 'new/nested/æ.txt', 'first\nsecond')
        assert change['event'] == 'approval_required' and not (root/'new').exists()
        error('approve', 'wrong', raw=True)
        request('deny', change['approval_id'], raw=True)
        assert not (root/'new').exists()
        change = request('write_file', 'new/nested/æ.txt', 'first\nsecond')
        request('approve', change['approval_id'], raw=True)
        assert (root/'new/nested/æ.txt').read_text() == 'first\nsecond'
        error('approve', change['approval_id'], raw=True)
        change = request('edit_file', 'hello.txt', 'world', 'native host')
        assert (root/'hello.txt').read_text() == 'hello world'
        request('approve', change['approval_id'], raw=True)
        assert (root/'hello.txt').read_text() == 'hello native host'
        error('edit_file', 'hello.txt', '', 'bad')
        change = request('write_file', 'hello.txt', 'proposal')
        (root/'hello.txt').write_text('external edit')
        error('approve', change['approval_id'], raw=True)
        assert (root/'hello.txt').read_text() == 'external edit'
        error('approve', change['approval_id'], raw=True)
        error('write_file', 'too-big', 'a' * 1048577)
        (root/'bad-utf8').write_bytes(b'\xff')
        error('read_file', 'bad-utf8')
        (root/'too-big').write_bytes(b'a' * 1048577)
        error('read_file', 'too-big')
        if os.name != 'nt':
            (root/'hello.txt').chmod(0o755)
            change = request('write_file', 'hello.txt', 'still executable')
            request('approve', change['approval_id'], raw=True)
            assert (root/'hello.txt').stat().st_mode & 0o777 == 0o755
            os.link(root/'hello.txt', root/'hardlink')
            error('read_file', 'hardlink')
            error('write_file', 'hello.txt', 'bad')
            (root/'link').symlink_to('/etc')
            error('read_file', 'link/passwd')
            os.mkfifo(root/'fifo')
            error('read_file', 'fifo')
        assert request('search_files', 'second')['text'] == 'new/nested/æ.txt:2:second'
        assert request('search_files', 'not-here')['text'] == 'No matches'
        error('search_files', '')
        process.stdin.write('shutdown\n'); process.stdin.flush()
        assert receive()['event'] == 'stopped'
        assert process.wait(timeout=10) == 0, process.stderr.read()
    finally:
        if process.poll() is None: process.kill(); process.wait()
print('native workspace: approvals, edits, tampering, bounds, UTF-8 and containment passed')
