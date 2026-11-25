# Training Stellan

The plan and the rules for training Stellan-1 Lite and Stellan-1 Max. Read this before every training run, and add what you learn. Licences and data provenance live in [MODEL_LICENSE.md](../MODEL_LICENSE.md); the older reinforcement-learning notes are in [HANDOVER.md](../HANDOVER.md) ("Deferred model training").

## The two models today

| | Stellan-1 Lite | Stellan-1 Max |
| --- | --- | --- |
| Job | Orchestrator: plans, calls tools, talks to the user | Code specialist: writes code when Lite asks, no tools |
| Architecture | Mamba2, 7.3B, width 4096, Mistral-style tokenizer | Llama/Mistral transformer, 23.6B, width 5120, 40 layers |
| Base | Not confirmed (record it before training) | Devstral Small 2505 (from Mistral Small 3.1), vision removed |
| On the stick | Q4_K_M GGUF, about 4.1 GB | Q4_K_M GGUF, about 14.3 GB |

Keep the original training checkpoints, tokenizer, config and LoRA adapters; train from those, not from the Q4 GGUFs.

## Rule 1: models and Stellan-Run are made for each other

Like Apple's M1, where chip and software were designed together, **Stellan models should be made to work well with Stellan-Run, and Stellan-Run should be made to work well with Stellan models.** In practice:

- **Train for the format we ship.** Lite and Max run as 4-bit (Q4_K) on the stick. Use quantisation-aware fine-tuning (or at least evaluate the Q4 export, never only full precision) so the stick version loses nothing.
- **Keep shapes the engine is fast at.** Widths and feed-forward sizes that are multiples of 256, head sizes that are multiples of 8. Don't add exotic layers (new norms, attention variants, activation functions) without first adding and benchmarking them in Stellan-Run.
- **Test every candidate in Stellan-Run, not only in PyTorch.** A candidate isn't "better" until its Q4 file passes the real Lite tool test (`scripts/smoke-platform.mjs`) and the benchmarks on Stellan-Run, with speed and memory recorded in `experimental/stellan-runtime/EVIDENCE.md`.
- **The engine adapts to the model too.** When the models change, Stellan-Run gets kernels specialised for the new shapes, and the stick stores weights pre-arranged for those kernels (see EVIDENCE.md, "Stellan-native layout").
- **Teach the exact protocol the app uses.** Lite must write one `<tool_call>{json}</tool_call>`, wait for `<tool_result>`, and finish with `<done>`. Never put tool requests inside `<done>`. On 24 November 2026 a reworded system prompt alone made the release Lite do that on every platform, so train on the real system prompt and tool format, and include examples of recovering from tool errors.

## Rule 2: EU models only

Every base model, adapter source and vision component comes from an EU company (for example Mistral, Paris). US or Chinese models can inspire methods but are not used as bases or teachers. Record every source and licence in MODEL_LICENSE.md.

## Rule 3: keep benchmarks clean

Evaluation and holdout tasks (HumanEval, SWE-bench slices, Vibe Code Bench, our internal suites, Forge holdouts) never go into training data. Forge's export already enforces this; keep it that way.

## Next training: give Lite and Max eyes (no third model)

Both models learn to see by sharing one image encoder ("the eye") plus a small adapter ("projector") each.

**The eye.** Mistral Small 3.1's ~0.4B Pixtral-style encoder (Mistral, Paris; Apache-2.0): patch 14, width 1024, 24 layers, 16 heads, gated SiLU MLP 4096, 2D RoPE (theta 10,000), images up to 1540 px. Mistral reuses the same frozen encoder in Ministral 3 (3B/8B/14B, Apache-2.0). Keep it **frozen**. Stellan-Run already runs it (`stellan-run see`), and on Mistral's real weights it matches llama.cpp (cosine 0.999; EVIDENCE.md, "The eye").

**Use SiLU, not GELU.** Mistral's original config said the encoder used GELU; Mistral corrected it to SiLU on 9 May 2025 (Hugging Face commit `73ce7c62b9`). Older converted files (including ggml-org's popular mmproj) still say `use_gelu`. Train with the corrected SiLU encoder, as Stellan-Run runs it.

**Max (easier).** Max descends from Mistral Small 3.1, which already has a projector for this eye (RMSNorm, 2×2 patch merger, two-layer GELU MLP into width 5120).
1. Start from Mistral Small 3.1's own projector weights.
2. Stage 1: train the projector only (eye and Max frozen) on image–caption pairs to re-align it to Max.
3. Stage 2: a short LoRA pass on image + code tasks: screenshots of errors, UI mock-ups to HTML/CSS, diagrams to code, photos of whiteboards.

**Lite (harder).** Lite is Mamba2 (width 4096); no ready projector exists.
1. New projector: RMSNorm, the same 2×2 patch merger (1024×4 → 1024), then a two-layer MLP 1024 → 4096 → 4096.
2. Stage 1: projector only (LLaVA-style) on image–caption pairs.
3. Stage 2: LoRA on image + tool-use tasks, so Lite can describe a screenshot and then act on it with tools.
4. Mamba2 with image tokens is less proven than transformers: measure it. If Lite can't see well enough, Lite hands image questions to Max.

**Image tokens in the prompt.** As Mistral 3: one token per merged 28×28 patch, `[IMG_BREAK]` after each row, `[IMG_END]` at the end. Stellan-Run's `see` produces exactly these rows; the break embedding comes from the mmproj file.

**Data.** Only datasets whose licences allow training and selling the result; record each in MODEL_LICENSE.md. Add our own: screenshots of real app UIs and errors produced by our test projects.

**Ship.** The trained projectors go in an mmproj GGUF next to each model (no engine change needed), integrity-checked and lockable like the models. The app then lets Stellan see attached images instead of only copying them.

**Checks.** Screenshots, photos of text, diagrams and code images; no made-up text in OCR checks; works offline; images never leave the computer. If training slips, a fallback is Ministral 3 3B (same eye, EU, Apache-2.0) as a hidden helper that turns images into text.

## Lessons from Inkling 2 Mini, to use later

[Inkling 2 Mini](https://thinkingmachines.ai/news/inkling-2-mini/) (Thinking Machines, 20 November 2026) is a 26.4B mixture-of-experts model with 3.4B active parameters per token, about 20 GB, which runs offline on a laptop and scores 77.9% on Vibe Code Bench v1.1. It's a US model, so we copy **ideas, not weights**:

- **Mixture of experts.** On a CPU, reply speed is set by how many weights are read per token. A ~25B-total, ~3–5B-active EU model would reply several times faster than today's dense 24B Max at similar quality. Strong candidate for Max's successor if an EU open-weight MoE of that size exists when we choose.
- **Trained natively in 4-bit** (NVFP4, last layers 8-bit). For us: quantisation-aware training for Q4_K (Rule 1).
- **Looped middle layers** (run three times per token): more reasoning per token, shorter answers, without memorising more facts. It needs training from scratch, and on a CPU each loop re-reads those weights, so measure decode speed in Stellan-Run before adopting it.
- **Tools instead of memorised facts.** It leads its size class on search and tool benchmarks because it looks things up. Train Stellan to use Actuent web search and read documentation well.
- **Long-horizon agentic work** is where it shines. Train Lite on long, multi-step tool sessions (tens of steps), not only short ones.
- **The demo.** An offline laptop on a flight built a playable flight simulator. Ours: Stellan builds a game offline on a stick, and the game's characters are powered by Stellan.

## Idea: RLM as an add-on to Lite and Max (owner, 24 November 2026)

The owner's **RLM (Rolling Language Model)**, a model that keeps learning from what it does, is its own project. Saved options for how it meets Stellan, to decide later:
1. **A separate project** that ships finished RLM models to Stick AI through normal updates.
2. **Built in this repository** alongside Stellan.
3. **An add-on to Lite and Max, added during training.** A small learning part (for example a rolling adapter or memory module) trained together with Lite and Max, so they can keep updating it after release while the base stays fixed.

Option 3 fits Rule 1 best: if the add-on is designed during training, Stellan-Run can support it from the start. Whatever is chosen, the rules don't change: learn only from verified, accepted work, guard against forgetting with a frozen regression suite, and never train on customer data without explicit opt-in.

## Data from Forge

[Forge](../HANDOVER.md) (open-source showcase and data loop) produces reviewed, verified attempts. Use only approved, passing attempts with an unambiguous outcome. Keep tool results in the exported examples (today only messages survive; fix that first). Exclude evaluation and holdout tasks. Record each repository's licence and its AI-contribution policy.

## Before and after every run

Before:
- [ ] Original checkpoints, tokenizer, config and adapters recovered and hashed.
- [ ] Data sources, revisions and licences recorded in MODEL_LICENSE.md.
- [ ] Holdout and benchmark tasks excluded and checked.

After:
- [ ] Q4 export runs in Stellan-Run and passes the real Lite tool test on all four platforms.
- [ ] HumanEval and the agentic suites don't regress; new scores recorded with date and setup.
- [ ] Speed and memory on Stellan-Run recorded against the previous model.
- [ ] New model hashes pinned; locked splits and integrity manifests rebuilt.

## Smaller versions for 8 GB computers (owner decision, 25 November 2026)

The next training run also produces **smaller Lite and Max files**, made from the full-precision weights (never by re-compressing the shipped 4-bit files, which loses quality). Why: on 8 GB Apple Silicon Macs, Lite's 4.15 GB file can exceed the free file cache, and the model is then re-read from disk for every word (see HANDOVER.md, "Open issue found overnight"). Targets:

- **Lite small:** about 3.3–3.5 GB (3-bit or mixed 3/4-bit), picked automatically on computers under 12 GB.
- **Max small:** a lower-bit Max for 16 GB computers, where the current 14.3 GB Max is very slow.
- Ship only if HumanEval stays within 3 points of the full version and the real tool smoke passes; record both in EVIDENCE.md. Stellan-Run gets kernels for the chosen formats (the M1 principle).
