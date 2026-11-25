#!/usr/bin/env python3
"""Open one reviewed Forge pull request from the bot account.

The fix must already be committed and pushed to a branch on the bot's fork (with an Assisted-by trailer). This
script only opens the PR, and only when every rule holds:

- the target project is in your allowlist file with its AI policy URL, checked in the last 7 days;
- the bot has no other open PR in that project;
- you typed the confirmation after reading the diff summary.

The disclosure is always added to the PR text. The token comes from FORGE_GITHUB_TOKEN and is never printed.
"""
import argparse, datetime, json, os, sys, urllib.request

API = 'https://api.github.com'
DISCLOSURE = ('\n\n---\n**AI assistance:** this change was written with Stellan {model}, an AI coding model, as part '
              'of the Stellan Forge project. {reviewer} reviewed and tested every line before opening this PR and '
              'will answer review comments. If AI-assisted contributions are not welcome here, say so and we will '
              'close this and not open more.')


class ForgeError(Exception):
    pass


def github(method, path, token, body=None):
    request = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                                              'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'stellan-forge'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def check_allowed(allowlist, repo, today):
    entry = next((e for e in allowlist if e.get('repo') == repo), None)
    if not entry:
        raise ForgeError(f'{repo} is not in your allowlist. Read its AI policy, then add it with the policy URL and date.')
    if not str(entry.get('policy_url', '')).startswith('https://'):
        raise ForgeError(f'{repo} needs the https link to its AI contribution policy.')
    checked = datetime.date.fromisoformat(entry.get('policy_checked', '1970-01-01'))
    if (today - checked).days > 7:
        raise ForgeError(f"{repo}'s AI policy was last checked on {checked}. Read it again today and update the date.")
    return entry


def open_pr(args, token, call=github, today=None, confirm=input):
    today = today or datetime.date.today()
    with open(args.allowlist, encoding='utf-8') as handle:
        check_allowed(json.load(handle), args.repo, today)
    bot = call('GET', '/user', token)['login']
    mine = [p for p in call('GET', f'/repos/{args.repo}/pulls?state=open&per_page=100', token) if p['user']['login'] == bot]
    if mine:
        raise ForgeError(f'The bot already has an open PR in {args.repo} ({mine[0]["html_url"]}). Wait until it is merged or closed.')
    compare = call('GET', f'/repos/{args.repo}/compare/{args.base}...{bot}:{args.branch}', token)
    files = compare.get('files', [])
    print(f'Project:  {args.repo}\nBranch:   {bot}:{args.branch} -> {args.base}\nTitle:    {args.title}')
    print(f'Changes:  {len(files)} files, +{sum(f["additions"] for f in files)} -{sum(f["deletions"] for f in files)}')
    for f in files[:30]:
        print(f'  {f["filename"]} (+{f["additions"]} -{f["deletions"]})')
    if not files:
        raise ForgeError('The branch has no changes against the base branch.')
    with open(args.body, encoding='utf-8') as handle:
        body = handle.read().strip() + DISCLOSURE.format(model=args.model, reviewer=args.reviewer)
    if confirm('Have you read every line, run the tests and do you stand behind it? Type OPEN to open the PR: ').strip() != 'OPEN':
        raise ForgeError('Not opened.')
    pr = call('POST', f'/repos/{args.repo}/pulls', token,
              {'title': args.title, 'head': f'{bot}:{args.branch}', 'base': args.base, 'body': body, 'maintainer_can_modify': True})
    print(f'Opened {pr["html_url"]}. Record the outcome in Forge when it is merged or closed.')
    return pr


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo', required=True, help='target project, owner/name')
    parser.add_argument('--branch', required=True, help="branch on the bot's fork")
    parser.add_argument('--base', default='main')
    parser.add_argument('--title', required=True)
    parser.add_argument('--body', required=True, help='file with the PR description (the disclosure is added)')
    parser.add_argument('--model', choices=['Lite', 'Max'], required=True)
    parser.add_argument('--reviewer', required=True, help='your name, as the person who reviewed it')
    parser.add_argument('--allowlist', required=True, help='JSON list of {repo, policy_url, policy_checked}')
    args = parser.parse_args()
    token = os.environ.get('FORGE_GITHUB_TOKEN')
    if not token:
        sys.exit('Set FORGE_GITHUB_TOKEN to the bot account token (from your secret storage, never typed into chat).')
    try:
        open_pr(args, token)
    except ForgeError as error:
        sys.exit(str(error))


if __name__ == '__main__':
    main()
