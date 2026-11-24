#!/usr/bin/env python3
"""Stellan Forge experience review and dataset preparation. Never executes recorded code."""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

LIMIT = 2 * 1024 * 1024
EXPORT_LIMIT = 32 * 1024 * 1024
SECRET = re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization\s*[:=]\s*["\x27]?(?:bearer|basic)\s+[^\s"\x27]+', re.I)
STATUSES = {'passed', 'failed', 'incomplete', 'infrastructure_error'}
BENCHMARKS = {'humaneval', 'swe-bench', 'swe-bench-verified'}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def read_json(path):
    path = Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > LIMIT:
        raise ValueError('Input must be a single-link regular JSON file under 2 MiB')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino) or opened.st_nlink != 1:
            raise ValueError('Input changed while opening')
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Input exceeds 2 MiB')
    return json.loads(data.decode('utf8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite JSON')))


def write_new(path, value):
    path = Path(path)
    data = canonical(value) + b'\n'
    if len(data) > LIMIT:
        raise ValueError('Output record exceeds 2 MiB')
    # Exclusive creation: review and source records are not silently overwritten.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def text(value, name, limit=65536):
    if not isinstance(value, str) or not value.strip() or len(value.encode('utf8')) > limit:
        raise ValueError(f'Invalid {name}')
    return value


def validate_payload(payload):
    if not isinstance(payload, dict) or set(payload) != {'format', 'task', 'runtime', 'messages', 'events', 'outcome'} or payload['format'] != 1:
        raise ValueError('Unsupported experience schema')
    task = payload['task']
    if not isinstance(task, dict) or set(task) != {'id', 'repository', 'revision', 'family', 'source', 'purpose'}:
        raise ValueError('Task provenance is required')
    for key in task:
        text(task[key], f'task.{key}', 1000)
    if task['source'].lower() not in {'forge', *BENCHMARKS}:
        raise ValueError('Unsupported task source')
    if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', task['revision']):
        raise ValueError('Pin the task repository or dataset revision')
    if task['purpose'] not in {'training', 'evaluation'}:
        raise ValueError('Task purpose must be training or evaluation')
    runtime = payload['runtime']
    if not isinstance(runtime, dict) or set(runtime) != {'host', 'run', 'link', 'harness', 'model_sha256'}:
        raise ValueError('Pin Host, Run, Link, harness and model identities')
    for key in runtime:
        if not isinstance(runtime[key], str) or not re.fullmatch('[a-f0-9]{64}' if key == 'model_sha256' else '[a-f0-9]{40}', runtime[key]):
            raise ValueError(f'Invalid runtime.{key}')
    messages = payload['messages']
    if not isinstance(messages, list) or not 2 <= len(messages) <= 256:
        raise ValueError('Expected 2–256 user/assistant messages')
    for item in messages:
        if not isinstance(item, dict) or set(item) != {'role', 'content'} or item['role'] not in {'user', 'assistant'}:
            raise ValueError('Invalid message')
        text(item['content'], 'message content')
    if messages[0]['role'] != 'user' or messages[-1]['role'] != 'assistant':
        raise ValueError('Experience must start with a user request and end with an assistant response')
    events = payload['events']
    if not isinstance(events, list) or len(events) > 1024:
        raise ValueError('Too many events')
    for event in events:
        if not isinstance(event, dict) or set(event) != {'kind', 'text'} or event['kind'] not in {'action', 'tool_result', 'error', 'correction', 'test'}:
            raise ValueError('Invalid experience event')
        text(event['text'], 'event text')
    outcome = payload['outcome']
    if not isinstance(outcome, dict) or set(outcome) != {'status', 'report_sha256', 'verifier'} or outcome['status'] not in STATUSES:
        raise ValueError('Invalid outcome')
    text(outcome['verifier'], 'verifier provenance', 2000)
    if not isinstance(outcome['report_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', outcome['report_sha256']):
        raise ValueError('Retain the test report and its SHA256')
    if SECRET.search(canonical(payload).decode('utf8')):
        raise ValueError('Possible credential found; redact and review the source first')
    if len(canonical(payload)) > LIMIT:
        raise ValueError('Experience exceeds 2 MiB')
    return payload


def record(payload):
    validate_payload(payload)
    return {'id': digest(payload), 'payload': payload, 'review': {'decision': 'pending', 'reviewer': '', 'notes': ''}}


def validate_record(value):
    if not isinstance(value, dict) or set(value) != {'id', 'payload', 'review'}:
        raise ValueError('Invalid review record')
    validate_payload(value['payload'])
    if value['id'] != digest(value['payload']):
        raise ValueError('Experience changed after recording/review')
    review = value['review']
    if not isinstance(review, dict) or set(review) != {'decision', 'reviewer', 'notes'} or review['decision'] not in {'pending', 'approved', 'rejected'}:
        raise ValueError('Invalid review')
    if not isinstance(review['notes'], str) or len(review['notes'].encode('utf8')) > 4000:
        raise ValueError('Invalid review notes')
    if review['decision'] != 'pending':
        text(review['reviewer'], 'reviewer', 200)
    return value


def review_record(value, decision, reviewer, notes):
    validate_record(value)
    if decision not in {'approved', 'rejected'}:
        raise ValueError('Choose approved or rejected')
    reviewed = {**value, 'review': {'decision': decision, 'reviewer': reviewer, 'notes': notes}}
    return validate_record(reviewed)


def group_for(payload):
    task = payload['task']
    return digest([task['repository'], task['family']])


def split_for(group):
    bucket = int(group[:8], 16) % 100
    return 'train' if bucket < 80 else 'validation' if bucket < 90 else 'holdout'


def corrected(events):
    errors = [i for i, event in enumerate(events) if event['kind'] == 'error']
    corrections = [i for i, event in enumerate(events) if event['kind'] == 'correction']
    tests = [i for i, event in enumerate(events) if event['kind'] == 'test']
    return bool(errors and corrections and tests and max(errors) < max(corrections) < max(tests))


def export_dataset(records, output, exclusions):
    if not isinstance(exclusions, dict) or set(exclusions) != {'task_ids', 'groups'} or any(not isinstance(exclusions[k], list) or any(not isinstance(v, str) for v in exclusions[k]) for k in exclusions):
        raise ValueError('Explicit holdout manifest with task_ids and groups is required')
    selected_by_id = {}
    count = 0
    total_bytes = 0
    for value in records:
        count += 1
        if count > 10000:
            raise ValueError('At most 10000 experience records per export')
        validate_record(value)
        total_bytes += len(canonical(value))
        if total_bytes > EXPORT_LIMIT:
            raise ValueError('Export input exceeds the 32 MiB memory budget; use smaller batches')
        previous = selected_by_id.get(value['id'])
        if previous:
            old, new = previous['review']['decision'], value['review']['decision']
            if old != 'pending' and new != 'pending' and previous['review'] != value['review']:
                raise ValueError('Conflicting reviews for the same experience')
            if old != 'pending': continue
        selected_by_id[value['id']] = value
    if not count:
        raise ValueError('Expected at least one experience')
    selected = list(selected_by_id.values())
    seen_ids = set(selected_by_id)
    blocked = set()
    blocked_prompts = set()
    prompt_groups = collections.defaultdict(set)
    def excluded(p):
        return p['task']['purpose'] == 'evaluation' or p['task']['source'].lower() in BENCHMARKS or p['task']['id'].lower().startswith('humaneval/') or p['task']['id'] in exclusions['task_ids'] or group_for(p) in exclusions['groups'] or split_for(group_for(p)) == 'holdout'
    for value in selected:
        p = value['payload']
        prompt = digest(p['messages'][0]['content'].replace('\r\n', '\n').strip())
        prompt_groups[prompt].add(group_for(p))
        if excluded(p):
            blocked.add(digest(p['messages']))
            blocked_prompts.add(prompt)
    rows = {'train': [], 'validation': []}
    counts = collections.Counter()
    contents = set()
    for value in selected:
        p = value['payload']
        reason = 'exported'
        if value['review']['decision'] != 'approved': reason = 'not_approved'
        elif excluded(p): reason = 'evaluation_or_holdout'
        elif p['outcome']['status'] != 'passed': reason = p['outcome']['status']
        elif digest(p['messages']) in blocked or digest(p['messages'][0]['content'].replace('\r\n', '\n').strip()) in blocked_prompts: reason = 'matches_holdout_content'
        elif len(prompt_groups[digest(p['messages'][0]['content'].replace('\r\n', '\n').strip())]) > 1: reason = 'ambiguous_prompt_group'
        elif any(e['kind'] == 'error' for e in p['events']) and not corrected(p['events']): reason = 'uncorrected_error'
        elif digest(p['messages']) in contents: reason = 'duplicate_content'
        counts[reason] += 1
        if reason != 'exported': continue
        contents.add(digest(p['messages']))
        split = split_for(group_for(p))
        rows[split].append({'experience_id': value['id'], 'group': group_for(p), 'messages': p['messages']})
    output = Path(output)
    staging = Path(tempfile.mkdtemp(prefix='.forge-export-', dir=output.parent))
    try:
        os.chmod(staging, 0o700)
        files = {}
        for split, items in rows.items():
            data = b''.join(canonical(item) + b'\n' for item in items)
            path = staging / f'{split}.jsonl'
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            files[path.name] = {'sha256': hashlib.sha256(data).hexdigest(), 'rows': len(items)}
        manifest = {'format': 1, 'scope': 'reviewed experience export; not a benchmark result or training run', 'selected_records': len(selected), 'input_records': count, 'counts': dict(counts), 'outcome_counts': dict(collections.Counter(v['payload']['outcome']['status'] for v in selected)), 'review_counts': dict(collections.Counter(v['review']['decision'] for v in selected)), 'exclusions_sha256': digest(exclusions), 'records': sorted(seen_ids), 'files': files}
        write_new(staging/'manifest.json', manifest)
        # Reserve the destination before moving files; never overwrite an existing dataset.
        output.mkdir(mode=0o700)
        try:
            for path in staging.iterdir(): path.rename(output/path.name)
        except BaseException:
            shutil.rmtree(output); raise
        return manifest
    finally:
        shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    ingest = sub.add_parser('record'); ingest.add_argument('--input', required=True); ingest.add_argument('--output', required=True)
    review = sub.add_parser('review'); review.add_argument('--input', required=True); review.add_argument('--output', required=True); review.add_argument('--decision', choices=['approved', 'rejected'], required=True); review.add_argument('--reviewer', required=True); review.add_argument('--notes', default='')
    export = sub.add_parser('export'); export.add_argument('--records', nargs='+', required=True); export.add_argument('--output', required=True); export.add_argument('--holdout-manifest', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'record': write_new(args.output, record(read_json(args.input)))
        elif args.command == 'review': write_new(args.output, review_record(read_json(args.input), args.decision, args.reviewer, args.notes))
        else: print(json.dumps(export_dataset((read_json(p) for p in args.records), args.output, read_json(args.holdout_manifest)), indent=2))
    except (ValueError, OSError, TypeError, UnicodeError) as error:
        parser.exit(2, f'Forge: {error}\n')

if __name__ == '__main__':
    main()
