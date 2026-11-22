# Pydantic #14304: negative indices in Sequence serialization

Status on 22 November 2026: **bug reproduced locally; no tested fix or upstream submission**.

- Issue: https://github.com/pydantic/pydantic/issues/14304
- Snapshot: open, unassigned, `bug V2` and `pending` (unconfirmed), zero comments. This is a provisional investigation, not a maintainer-approved help-wanted task. Do not take ownership or submit a PR without assignment.
- Source checkout: `1aaef01805ae0bc436954a4e863cc0b64a827193` from `pydantic/pydantic` main, for policy/source inspection. Licence: MIT; the retained source excerpt in the prompt is covered by [PYDANTIC_LICENSE.txt](PYDANTIC_LICENSE.txt). No CLA/DCO requirement was found in the inspected contribution guide; recheck the submission template and current rules before submitting.
- Policy: https://github.com/pydantic/pydantic/blob/1aaef01805ae0bc436954a4e863cc0b64a827193/docs/contributing.md. It explicitly welcomes AI use, requires the contributor to understand the code, and says PRs for existing issues are automatically closed without assignment. Root `AGENTS.md` directs agents to the contribution guide. Both were read.
- Reproduction environment: Python 3.12, Linux x64, isolated venv, Pydantic **2.14.3** (the issue's reported release), installed from PyPI. The main checkout was not patched or used for the versioned reproduction. `environment.txt` retains dependency versions.
- Run: `python reproduce.py`; expected two surviving items. Actual: `PydanticSerializationError` wrapping `ValueError: Negative indices cannot be used to exclude items on unsized iterables`. See [before.txt](before.txt); local filesystem paths are redacted.
- Diagnosis scope: the Python serializer passes each item and index to a handler without the full sequence length. Any proposed change must cover negative include/exclude indices, nested field filters, `__all__`, both output modes and existing sequence types, and preserve existing behaviour for positive indices.

## Attribution and model evidence

The issue search, policy review, reproduction and initial diagnosis prompt were prepared by Codex, with no human code edits. No Stellan-authored fix is claimed. `lite-prompt.txt`, `lite-trace.json` and `lite-diagnostic.json` retain the actual local Lite diagnostic and all generated token events (repetitive prompt-progress events and top-logit diagnostics omitted) from the completed probe. This probe uses the **experimental independent CPU runtime**, not the production Stick AI agent or a Lite→Max tool run. The model is the verified release Lite GGUF, SHA-256 `84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e`, two CPU threads. Its receipt records the engine hash, elapsed time and model metrics. Raw traces may contain a truncated or unsuccessful answer and must not be presented as a verified fix.

Max was not run: the host has approximately 9.7 GiB RAM, below its guard. A full production Lite→Max demonstration needs a suitable machine and a confirmed/assigned issue before submission. Local reproduction is useful evidence; it is not maintainer acceptance.

## Next concrete step

Human-review the reproduction and candidate choice, then obtain assignment if pursuing this issue. On a suitable host, run the production Lite→Max pair with the reproduction and pinned source, keep every approval/tool event, save the proposed diff and human interventions, and run Pydantic's focused tests plus required checks. Retain the original failing case and all failed attempts. Do not publish a success claim until a reviewed fix exists.

## First local Lite attempt: unsuccessful

Lite produced 256 tokens and reached the diagnostic token cap. Its suggestion to ignore negative indices or reject them does not implement the required behaviour (exclude the last item). The code block was incomplete. We retained the raw response and applied nothing. This attempt is an unsuccessful diagnostic, not a completed fix or evidence that the production agent can solve the issue. The next attempt should explicitly require equivalence with the existing list serializer and test negative-index semantics.
