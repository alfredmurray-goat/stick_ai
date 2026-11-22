#!/usr/bin/env python3
"""Validate a ten-task submission and grade with the pinned official Docker harness."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

HARNESS_SHA = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'
MODELS = ('stellan-1-lite', 'stellan-1-max')
DATASET = 'princeton-nlp/SWE-bench_Verified'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def submission(root):
    root = Path(root)
    manifest = root / 'swe-tasks.jsonl'
    tasks = [json.loads(line) for line in manifest.read_text().splitlines() if line.strip()]
    ids = [task['instance_id'] for task in tasks]
    if len(ids) != 10 or len(set(ids)) != 10 or any(not re.fullmatch(r'[A-Za-z0-9_.-]+', id_) for id_ in ids):
        raise ValueError('Expected the original ten unique task IDs.')
    meta = json.loads(Path(str(manifest) + '.meta.json').read_text())
    if meta['sha256'] != digest(manifest) or meta['count'] != 10 or meta['dataset'] != DATASET or not re.fullmatch(r'[0-9a-f]{40}', meta.get('revision', '')):
        raise ValueError('Task manifest does not match its preparation receipt.')
    predictions = {}
    for model in MODELS:
        files = [root / f'swe-{model}' / 'predictions.jsonl', root / ('swe-max' if model.endswith('max') else 'swe-lite') / 'predictions.jsonl']
        present = [p for p in files if p.exists()]
        if len(present) > 1:
            raise ValueError('Multiple prediction files for one model; choose the intended submission.')
        rows = [json.loads(line) for line in present[0].read_text().splitlines() if line.strip()] if present else []
        seen = {}
        for row in rows:
            id_ = row['instance_id']
            if set(row) != {'instance_id', 'model_name_or_path', 'model_patch'} or row['model_name_or_path'] != model or id_ not in ids or id_ in seen or not isinstance(row['model_patch'], str):
                raise ValueError('Unexpected, duplicate or invalid model prediction.')
            seen[id_] = row
        predictions[model] = seen
    return ids, predictions


def plan(root):
    ids, _ = submission(root)
    return {'include': [{'model': model, 'instance': id_} for model in MODELS for id_ in ids]}


def evaluation_dataset(root, instance, out):
    from datasets import load_dataset
    root = Path(root)
    meta = json.loads((root / 'swe-tasks.jsonl.meta.json').read_text())
    selected = next(json.loads(line) for line in (root / 'swe-tasks.jsonl').read_text().splitlines() if json.loads(line)['instance_id'] == instance)
    dataset = load_dataset(DATASET, split='test', revision=meta['revision'])
    row = next(row for row in dataset if row['instance_id'] == instance)
    if any(row[key] != selected[key] for key in ('instance_id', 'repo', 'base_commit', 'problem_statement')):
        raise ValueError('Grading dataset does not match the inference task.')
    target = Path(out) / 'evaluation-dataset.json'
    write(target, [dict(row)])
    return target.resolve()


def task(args):
    ids, predictions = submission(args.submission)
    if args.model not in MODELS or args.instance not in ids:
        raise ValueError('Task is not part of the selected manifest.')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', args.run_id):
        raise ValueError('Invalid run ID.')
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    receipt = dict(model=args.model, instance_id=args.instance, denominator=len(ids), harnessCommit=HARNESS_SHA,
                   manifestSha256=digest(Path(args.submission) / 'swe-tasks.jsonl'), status='infrastructure_error', resolved=False)
    target = out / f'{args.model}-{args.instance}.json'
    row = predictions[args.model].get(args.instance)
    if row is None:
        receipt['status'] = 'missing_prediction'; write(target, receipt); return
    receipt['predictionSha256'] = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()
    if not row['model_patch'].strip():
        receipt['status'] = 'empty_patch'; write(target, receipt); return
    try:
        if shutil.disk_usage(out).free < 15 * 1024 ** 3:
            raise RuntimeError('Less than 15 GiB free; use a Docker host with more space.')
        info = subprocess.run(['docker', 'info'], capture_output=True, text=True, check=True)
        (out / 'docker-info.txt').write_text(info.stdout)
        actual = subprocess.check_output(['git', '-C', str(Path(args.harness).resolve()), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != HARNESS_SHA:
            raise ValueError('Harness revision differs from the pinned evaluator.')
        with (out / 'pip-freeze.txt').open('w') as f:
            subprocess.run([sys.executable, '-m', 'pip', 'freeze'], stdout=f, check=True)
        prediction_file = out / 'prediction.jsonl'; prediction_file.write_text(json.dumps(row) + '\n')
        dataset_path = evaluation_dataset(args.submission, args.instance, out)
        command = [sys.executable, '-m', 'swebench.harness.run_evaluation', '--dataset_name', str(dataset_path),
                   '--instance_ids', args.instance, '--predictions_path', str(prediction_file),
                   '--max_workers', '1', '--run_id', args.run_id, '--timeout', '1800']
        write(out / 'command.json', command)
        with (out / 'harness.log').open('w') as f:
            result = subprocess.run(command, cwd=out, stdout=f, stderr=subprocess.STDOUT, timeout=3600)
        receipt['exitCode'] = result.returncode
        report_path = out / 'logs' / 'evaluation' / args.run_id / 'results.json'
        report = json.loads(report_path.read_text())
        write(out / 'official-results.json', report)
        if args.instance in report.get('infra_failure_ids', []) or args.instance in report.get('error_ids', []) or args.instance in report.get('incomplete_ids', []) or result.returncode != 0:
            receipt['status'] = 'infrastructure_error'
        elif args.instance in report.get('resolved_ids', []):
            receipt.update(status='resolved', resolved=True)
        elif args.instance in report.get('unresolved_ids', []):
            receipt['status'] = 'unresolved'
        elif args.instance in report.get('empty_patch_ids', []):
            receipt['status'] = 'empty_patch'
        else:
            raise ValueError('Official report does not account for the selected task.')
        receipt['ambiguousFailure'] = args.instance in report.get('ambiguous_failure_ids', [])
    except (OSError, ValueError, RuntimeError, KeyError, StopIteration, subprocess.SubprocessError) as error:
        receipt['error'] = str(error)
    write(target, receipt)
    print(json.dumps(receipt))


def aggregate(root, reports):
    ids, _ = submission(root)
    expected_hash = digest(Path(root) / 'swe-tasks.jsonl')
    receipts = {}
    for file in Path(reports).rglob('stellan-1-*.json'):
        row = json.loads(file.read_text())
        key = (row['model'], row['instance_id'])
        if key in receipts or key[0] not in MODELS or key[1] not in ids or row['manifestSha256'] != expected_hash or row['harnessCommit'] != HARNESS_SHA:
            raise ValueError('Duplicate or unrelated grading receipt.')
        receipts[key] = row
    output = {'dataset': DATASET, 'harnessCommit': HARNESS_SHA, 'selectedTaskCount': len(ids), 'models': {}}
    for model in MODELS:
        counts = {name: 0 for name in ('resolved', 'unresolved', 'empty_patch', 'missing_prediction', 'infrastructure_error', 'missing_report')}
        for id_ in ids:
            status = receipts.get((model, id_), {}).get('status', 'missing_report')
            if status not in counts:
                raise ValueError('Unknown grading status.')
            counts[status] += 1
        complete = not any(counts[k] for k in ('missing_prediction', 'infrastructure_error', 'missing_report'))
        output['models'][model] = dict(counts, ambiguousFailures=sum(bool(receipts.get((model, id_), {}).get('ambiguousFailure')) for id_ in ids), denominator=len(ids), observedResolvedFraction=counts['resolved'] / len(ids),
                                     gradingComplete=complete, passAt1=counts['resolved'] / len(ids) if complete else None)
    return output


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['plan', 'task', 'aggregate'])
    p.add_argument('--submission', required=True)
    p.add_argument('--model', choices=MODELS)
    p.add_argument('--instance')
    p.add_argument('--harness')
    p.add_argument('--run-id')
    p.add_argument('--reports')
    p.add_argument('--out')
    args = p.parse_args()
    if args.action == 'plan':
        print(json.dumps(plan(args.submission)))
    elif args.action == 'task':
        if not all((args.model, args.instance, args.harness, args.run_id, args.out)):
            p.error('task requires --model, --instance, --harness, --run-id and --out')
        task(args)
    else:
        if not args.reports or not args.out:
            p.error('aggregate requires --reports and --out')
        result = aggregate(args.submission, args.reports)
        write(args.out, result)
        print(json.dumps(result, indent=2))
        if not all(row['gradingComplete'] for row in result['models'].values()):
            sys.exit(2)

if __name__ == '__main__':
    main()
