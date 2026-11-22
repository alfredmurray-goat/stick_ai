# SWE-bench Verified: Lite and Max pilot

Use [kaggle-swe-verified.ipynb](kaggle-swe-verified.ipynb) with Internet enabled and GPU T4 x2, **Save Version → Save & Run All**. Start with ten tasks. It builds the pinned production llama.cpp, verifies each model, runs them sequentially on the same task manifest, and retains prompts, raw answers, predictions, hashes and logs under Output. Import prior Output and copy its `swe-*` folders and `swe-tasks.jsonl*` into `/kaggle/working` to resume. It does not contact maintainers or execute generated patches.

This is a **one-shot lexical-retrieval model baseline**, not the Stick AI Lite→Max agent loop. One temperature-zero answer per task, no repair attempts or best-of-N. Repository context comes only from source at `base_commit`, ranked using the issue text. Gold patches, hints, FAIL_TO_PASS, PASS_TO_PASS and hidden tests are never exported into the inference manifest. Both models get the same manifest and retrieval budget. Empty or malformed model patches remain attempts. Transport errors stop the run for investigation; receipts prevent repeating completed model answers.

SWE-bench Verified has 500 human-verified repository issues. A ten-task deterministic sample is a pilot, never a full leaderboard score. It is a more realistic repository task than HumanEval, but these are historical issues; this is not a fresh contamination-free test. Keep these evaluation tasks out of training.

## Manual inference

Python 3.10+, Git and a local OpenAI-compatible llama.cpp server are needed. `datasets` and `huggingface_hub` are preparation-only dependencies, not app dependencies.

```bash
python3 -m pip install datasets huggingface_hub
python3 scripts/benchmark-swe.py --prepare --tasks swe-tasks.jsonl --limit 10 --seed 42
```

The default dataset revision is pinned to `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`; preparation records it. Reuse that manifest for both models; use `--revision <recorded SHA>` when recreating it. Start the server with an 8192-token context (the notebook records all arguments). Then:

```bash
python3 scripts/benchmark-swe.py --tasks swe-tasks.jsonl \
  --endpoint http://127.0.0.1:18100 --model stellan-1-max \
  --server-bin /absolute/path/llama-server --gguf /absolute/path/max.gguf \
  --out swe-max
```

Repeat with the Lite server, `--model stellan-1-lite` and `--out swe-lite`. Its Mistral-v1 chat formatter is set in the notebook. A new output directory is required when model, runtime, script, manifest or generation settings change. Hashes identify the supplied runtime/model files; when using a separately launched endpoint you must ensure it actually serves those files. The notebook manages this connection directly and retains the launch arguments.

## Official scoring: separate Linux Docker host

Kaggle can generate predictions, but generally cannot run the required Docker daemon. Download the Output and grade on a Linux x86-64 Docker machine with ample disk space. Use one worker first; avoid renting anything until ready to pay for it. No hosted paid evaluation is started by this script.

Follow the [official setup](https://www.swebench.com/SWE-bench/guides/quickstart/), install `swebench`, retain its version/commit and `pip freeze`, and check `docker info`. Then run:

```bash
python3 -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path swe-max/predictions.jsonl \
  --max_workers 1 --run_id stellan-max-pilot-001

python3 -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path swe-lite/predictions.jsonl \
  --max_workers 1 --run_id stellan-lite-pilot-001
```

Use a **new run ID whenever predictions change**: the harness caches prior grades. Do not pass `gold` for model scoring. Keep the selected task count as denominator, disclose incomplete inference, build/test infrastructure errors and unresolved patches separately, and retain the full official reports. Report **one-attempt resolved rate (pass@1)** only after official grading. A generated or applicable patch is not a solved issue. Ten tasks are not 500 tasks. No result has been measured yet.

[Official prediction format and evaluation details](https://www.swebench.com/SWE-bench/guides/evaluation/).

## Managed grading after Kaggle finishes

Send the Kaggle **Output ZIP** after both models finish. The assistant can validate its task manifest and prediction files and prepare a sanitized submission branch. No need to run the Docker commands yourself. Keep the original `swe-tasks.jsonl` and its `.meta.json`, plus both `swe-stellan-1-*/predictions.jsonl` files. Raw inference/model server logs are not needed on the submission branch.

The manual **Grade SWE-bench pilot** workflow uses a standard Linux x86-64 GitHub Actions runner. Each of the twenty model/task pairs gets a fresh runner; `max-parallel: 1` and official `--max_workers 1` keep grading sequential. It checks Docker and free space, pins the official harness to `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`, loads the dataset revision recorded during inference, and verifies the selected issue/source commit match before grading. Gold tests are only loaded by the evaluator, never sent back to the model. Each run ID includes the Actions run number and attempt to avoid stale cached grades.

Workflow input `submission_ref` identifies a same-repository branch containing the sanitized files under `benchmark-submission/`. No evaluation is launched until a valid submission is available. No rented machine, larger paid runner or hosted evaluation service is configured. Availability and account Actions policies still apply. A task that exceeds the runner's disk/time limits is reported as an infrastructure failure, not a model-quality result.

Artifacts retain Docker details, pip freeze, invocation, prediction hash, official per-instance logs and report. `swe-pilot-summary` keeps **ten selected tasks per model** as the denominator, reports empty patches, missing outputs/reports and infrastructure problems separately, and leaves `passAt1` unset until grading is complete. Summary jobs fail when grading is incomplete so a green workflow cannot be mistaken for complete evaluation. A passing setup test is not a measured SWE-bench result.
