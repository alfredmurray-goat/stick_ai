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

Exports are preparation artifacts, **not pass@1 or resolved-rate measurements**. Learning notes, accepted patches and a model claiming success are not solved tasks. Forge currently does not run agent tasks, grade generated code, produce rewards, invoke optimizers, restore training checkpoints or implement RL. Future task execution needs isolation, approvals, interruption recovery and trusted verifier reports before anything is presented as a benchmark. The same project will own those additions; there is no separate unnamed/RL project.

## Test

```bash
python3 -m unittest discover -s experimental/stellan-forge/tests -v
```

Next integration: opt-in agent task recording, resumable run manifests including failures, isolated trusted verifiers and reviewed error-to-correction examples. Then connect the free-Kaggle continued-training workflow, preserving the existing Stellan weights, and compare on frozen held-out tasks before promotion.
