import hashlib, json, pathlib, subprocess, sys, tempfile
binary=sys.argv[1]
with tempfile.TemporaryDirectory() as folder:
    root=pathlib.Path(folder)
    key='12345678-1234-4567-8123-123456789abc'
    def start():
        child=subprocess.Popen([binary,'--state-store',folder],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf8')
        assert json.loads(child.stdout.readline())['scope']=='session-state'
        return child
    def call(child,text):
        child.stdin.write(text+'\n');child.stdin.flush()
        return json.loads(child.stdout.readline())
    child=start()
    try:
        second=subprocess.run([binary,'--state-store',folder],input='shutdown\n',capture_output=True,text=True,timeout=5)
        assert second.returncode!=0 and 'owned' in second.stderr
        assert call(child,f'1 state_get {key}')['revision']=='missing'
        payload='persistent notes æ 🦈'
        result=call(child,f'2 state_put {key} missing {payload.encode().hex()}')
        revision=hashlib.sha256(payload.encode()).hexdigest()
        assert result['revision']==revision
        assert call(child,f'3 state_put {key} missing 61')['event']=='error'
        assert call(child,f'4 state_get {key}')['text']==payload
        assert call(child,'5 state_get ../escape')['event']=='error'
        assert call(child,f'6 state_put {key} {revision} '+('61'*65537))['event']=='error'
        assert call(child,f'7 state_put {key} {revision} ff')['event']=='error'
        assert call(child,'shutdown')['event']=='stopped';assert child.wait(timeout=5)==0
    finally:
        if child.poll() is None:child.kill();child.wait()
    child=start()
    try:
        assert call(child,f'1 state_get {key}')['text']==payload
        assert call(child,f'2 state_put {key} {revision} -')['bytes']==0
        assert call(child,f'3 state_get {key}')['exists'] is True
        call(child,'shutdown');assert child.wait(timeout=5)==0
    finally:
        if child.poll() is None:child.kill();child.wait()
print('native state: exclusive ownership, CAS, persistence, bounds and UTF-8 passed')
