import datetime, json, os, sys, tempfile, types, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pr

TODAY = datetime.date(2026, 11, 25)

class PrTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.allow = os.path.join(self.dir, 'allow.json'); self.body = os.path.join(self.dir, 'body.md')
        json.dump([{'repo': 'go-gitea/gitea', 'policy_url': 'https://example.org/policy', 'policy_checked': '2026-11-24'}], open(self.allow, 'w'))
        open(self.body, 'w').write('Fixes #1.')
        self.args = types.SimpleNamespace(repo='go-gitea/gitea', branch='fix-1', base='main', title='Fix it', body=self.body, model='Lite', reviewer='Alfred', allowlist=self.allow)
        self.posted = []
    def call(self, open_prs=()):
        def fake(method, path, token, body=None):
            if path == '/user': return {'login': 'stellan-forge-bot'}
            if '/pulls?' in path: return list(open_prs)
            if '/compare/' in path: return {'files': [{'filename': 'a.go', 'additions': 3, 'deletions': 1}]}
            self.posted.append(body); return {'html_url': 'https://github.com/x/pull/9'}
        return fake
    def test_opens_with_disclosure_after_confirmation(self):
        pr.open_pr(self.args, 't', self.call(), TODAY, lambda _: 'OPEN')
        self.assertIn('Stellan Lite', self.posted[0]['body']); self.assertIn('Alfred reviewed', self.posted[0]['body'])
        self.assertEqual(self.posted[0]['head'], 'stellan-forge-bot:fix-1')
    def test_refuses_without_confirmation(self):
        with self.assertRaises(pr.ForgeError): pr.open_pr(self.args, 't', self.call(), TODAY, lambda _: 'yes')
        self.assertEqual(self.posted, [])
    def test_one_open_pr_per_project(self):
        with self.assertRaises(pr.ForgeError):
            pr.open_pr(self.args, 't', self.call([{'user': {'login': 'stellan-forge-bot'}, 'html_url': 'u'}]), TODAY, lambda _: 'OPEN')
    def test_stale_policy_check_and_unknown_repo(self):
        with self.assertRaises(pr.ForgeError): pr.open_pr(self.args, 't', self.call(), TODAY + datetime.timedelta(days=8), lambda _: 'OPEN')
        self.args.repo = 'godotengine/godot'
        with self.assertRaises(pr.ForgeError): pr.open_pr(self.args, 't', self.call(), TODAY, lambda _: 'OPEN')

if __name__ == '__main__': unittest.main()
