# Stellan Forge

One project for the agent demo, task experience, evaluation and eventual reinforcement learning. The first component is a dependency-free Python3.12 experience review/export CLI. It never executes recorded code, trains weights, uploads project data or automatically captures chat content.

## Run the synthetic walkthrough

From the repository root, choose a new private local output folder:

```bash
mkdir forge-walkthrough
python3 experimental/stellan-forge/forge.py record --input experimental/stellan-forge/examples/synthetic-experience.json --output forge-walkthrough/pending.json
python3 experimental/stellan-forge/forge.py review --input forge-walkthrough/pending.json --output forge-walkthrough/reviewed.json --decision approved --reviewer "local reviewer" --notes "Synthetic CLI check only"
python3 experimental/stellan-forge/forge.py export --records forge-walkthrough/reviewed.json --holdout-manifest experimental/stellan-forge/examples/holdout.json --output forge-walkthrough/dataset
```

This fixture uses placeholder hashes and evaluation-only purpose. Its export must contain **zero training rows**, demonstrating that reviewer approval cannot turn an evaluation task into training data. It is not a model run or benchmark score. Put real task reports and reviewed records in an owner-chosen private folder outside the source checkout. Do not commit them.

## Real experience contract

The example shows the exact schema. Replace the placeholders with actual task repository/dataset revisions, Host/Run/Link/harness commits and model SHA256. Preserve the chronological user/assistant messages exactly, including the tagged tool protocol. Record structured action, tool-result, error, correction and test events. `outcome.report_sha256` points to a retained verifier report; a reviewer must inspect that report and the actual tests. A supplied `passed` label is not independent proof that an issue was solved.

All raw records begin pending. Review explicitly into a new file with a reviewer name and notes. The payload hash catches accidental modification after review. Review files are local attestations, not cryptographically signed credentials; protect their directory and review provenance. The credential detector is only a best-effort backstop. Manual redaction, permission review and near-duplicate/leakage audit remain necessary. No automatic model training consumes these files.

Export rules:

- Only explicitly approved records with a passed reported outcome can be eligible. Failed, incomplete and infrastructure-error records remain visible in the manifest counts, not in successful targets.
- Error-bearing trajectories need a later correction followed by a later test event. The reviewer still verifies the actual correction and report.
- Evaluation-purpose, known HumanEval/SWE sources, explicit holdout task IDs/groups and deterministic holdout groups never enter train/validation files. Exact message content or the normalized first-user prompt matching any held-out record is excluded even under a different task identity or answer. Prompts assigned to multiple declared task groups are quarantined rather than silently crossing splits.
- Task groups use repository plus task family, so attempts/corrections in that group share a stable80/10/10 train/validation/holdout bucket. Small corpora need not have those exact proportions. Declare families consistently and group related repositories manually when necessary; this is not automatic semantic leakage detection.
- Exact duplicate payloads are deduplicated. A reviewed version supersedes its pending copy. Conflicting completed reviews stop export. Counts distinguish input records from unique selected records.
- Records are at most2MiB and exports accept at most10,000 records/32MiB of serialized input per batch. JSON object overhead can exceed serialized bytes; this is an input budget, not a measured process-RAM ceiling. Files cannot silently overwrite existing records or dataset directories. A completed dataset contains train/validation JSONL plus a manifest of hashes, source record IDs, exclusions hash and inclusion/exclusion counts. Retain the actual exclusions manifest beside the source inputs. Treat an export directory without its completed manifest as incomplete.

Exports are preparation artifacts, **not pass@1 or resolved-rate measurements**. Learning notes, accepted patches and a model claiming success are not solved tasks. The experience CLI itself does not execute tasks. The separate runner described below executes a configured adapter and trusted verifier; it does not yet supply a qualified Stellan agent adapter, produce learned rewards, invoke optimizers, restore training checkpoints or implement RL. Future task execution needs isolation, approvals, interruption recovery and trusted verifier reports before anything is presented as a benchmark. The same project will own those additions; there is no separate unnamed/RL project.

## Test

```bash
python3 -m unittest discover -s experimental/stellan-forge/tests -v
```

Next integration: opt-in agent task recording, resumable run manifests including failures, isolated trusted verifiers and reviewed error-to-correction examples. Then connect the free-Kaggle continued-training workflow, preserving the existing Stellan weights, and compare on frozen held-out tasks before promotion.

## One-attempt task runs

`runner.py` adds a resumable local-Docker execution path. `plan` snapshots the adapter, task inputs, prompt and trusted verifier, fixes the selected task list and creates a new run ID. It runs nothing and pulls no images. `run` uses only the fixed local Docker socket/pipe, a locally present digest-pinned Linux image and a one-attempt budget. It never selects a remote Docker context or requests hosted compute. Container CPU, memory, process, temporary filesystem and output budgets are explicit; seed/adapter/input/candidate/verifier mounts are read-only. The verifier is mounted only in a separate grading container, not in the agent container.

The included adapter, add-function success and deliberate syntax-error failure are **synthetic harness fixtures**, not a model, a HumanEval task or a measured model result. With a suitable Python3 image already provisioned in your local Docker cache, use its repository digest:

```bash
python3 experimental/stellan-forge/runner.py plan --suite experimental/stellan-forge/examples/task-suite.json --output /your/private/new-forge-run --image 'python@sha256:REPLACE_WITH_YOUR_LOCAL_IMAGE_DIGEST'
python3 experimental/stellan-forge/runner.py run --run /your/private/new-forge-run
python3 experimental/stellan-forge/runner.py summary --run /your/private/new-forge-run
```

The placeholder digest deliberately cannot run. Inspect the actual cached image with `docker image inspect` and choose its recorded `RepoDigests` value. Provision images explicitly yourself; the runner uses `--pull never`. The fixture's placeholder runtime hashes are labeled synthetic and must be replaced with exact real identities for model runs. The optional Ubuntu CI smoke explicitly provisions a Python fixture image, pins its resolved digest, then runs the synthetic adapter, isolated verifier, resume check and review/export handoff. It must grade the corrected fixture as passed and the syntax-error candidate as failed; both remain selected. This is an infrastructure test, not hosted model evaluation.

Adapter contract: print exactly one JSON object to stdout with `runtime` matching the selected pins and a bounded `files` object mapping safe relative paths to UTF-8 edits; `null` explicitly deletes a file. Edits are overlaid on the seed snapshot, preserving unchanged files. Diagnostics go to stderr. Copy/read the original files from `/seed`; use `/workspace` for temporary work. The prompt and runtime identities are in `/input/task.json`; adapter files are in `/adapter`. Native engines/model weights must already be available in your pinned image and verified by your real adapter. The supplied fixture does not invoke Stellan. Real Stellan agent/model wiring remains to be implemented and qualified.

The configured trusted verifier runs independently with `/candidate` and `/verify` read-only, after the agent container has exited. Its argv must refer to trusted verifier code. It returns `{"passed":true,"checks":[{"name":"actual check","passed":true}]}`; a pass requires exit0, a true overall flag and all checks true. Generated files alone cannot pass. A pinned image and trusted verifier remain part of the evaluation trust boundary; Docker is isolation infrastructure, not proof that tests are meaningful or that kernel isolation is perfect.

Each selected task is claimed once before execution. Completed receipts are reused on resume; they are not graded again. An interrupted claimed attempt has its named containers removed and is retained as incomplete, never automatically retried. Failures, unresolved patches, incomplete runs, infrastructure errors and pending tasks keep the original selected denominator. Use a new plan/run ID when inputs, prompts, adapters, predictions or settings change. Snapshot changes and modified grading receipts are rejected. The run has an exclusive owner lock; do not delete `.owner.lock` while it is active. A plan directory without completed `run.json` is not a valid run. Keep the whole run directory, including raw bounded stdout/stderr and verifier/prediction receipts.

If the adapter also returns chronological `messages` and `events`, Forge creates an `experience.pending.json` record after grading, using the actual receipt hash and task provenance. Export still requires explicit review. Invalid/secret-bearing experience is marked blocked without changing the grading outcome; a failed task is not a successful training target. The synthetic fixture is evaluation-only and cannot enter training even if reviewed.

Limits: one task at a time;2CPUs/8GiB container memory,128processes,256MiB workspace tmpfs and64MiB temporary tmpfs; timeout configurable1–3600seconds;2MiB stdout/64KiB stderr per stage; generated edits at most1MiB total/256KiB per file, in addition to the bounded seed snapshot. Snapshots have entry/file/byte budgets. Host disk space must still cover the cached image, immutable snapshots and retained reports. The first CLI currently uses the standard local socket or Windows pipe; alternate rootless socket configuration is not implemented. It produces receipt counts, not an official SWE/HumanEval score or a pass@1 claim. No new model benchmark or weight training has been measured here.
