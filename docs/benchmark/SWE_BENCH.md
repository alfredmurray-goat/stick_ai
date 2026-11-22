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
