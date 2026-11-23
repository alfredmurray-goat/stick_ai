# Stellan project plan

Owner directions, 22 November 2026. This file is the shared project memory for these decisions.

## Stellan-Run

The independent runtime is called **Stellan-Run**. The next replacement PR should make the app use it instead of llama.cpp, supported by measured correctness, faster operation and lower host load for both Lite and Max. Keep optimizing and integrating it until those results are established; do not claim an unfinished prototype has already achieved them.

## One unnamed learning and benchmark project

The unnamed coding initiative, its benchmark and reinforcement learning are one project. Real coding attempts supply experience: actions, tool calls, patches, errors, failing tests, recovery attempts, verified outcomes and human corrections. Retain unsuccessful attempts as well as successes. Lite learns orchestration and recovery; Max learns correct code and fixes.

Use a versioned task suite with separate training and held-out evaluation splits. Evaluate candidates before training and compare later versions on untouched tasks. Curate and review experience before versioned training and deployment; recording traces alone does not update weights.

Report the selected denominator, incomplete attempts, infrastructure errors, human intervention, one-attempt verified success rate, latency and resource use. A generated patch is not a solved issue. Call these this project's benchmark results, not official SWE-bench scores unless its official dataset and evaluator were used. Do not train on held-out evaluation tasks.

Continue runtime and app/runner input support while this is the saved plan. This does not start paid training, rent hardware, contact maintainers or submit upstream changes.

## Our own core components

Prefer progressively replacing major third-party components with original Locali Labs implementations where we can establish better speed, lower resource use, reliability or product behavior. Stellan-Run replacing llama.cpp is the first example. This is a broader direction for core capabilities, not a request to remove every dependency regardless of value. Preserve working features, validate replacements and make measured claims.

## Memory and context defaults

Prioritize low RAM by default. Keep a larger, potentially slower context window as an obvious sidebar option next to a context-usage wheel. Allocate Max's cache as tokens are used instead of reserving the full window upfront. Retain per-chat memory files locally and recall bounded notes rather than forcing the entire conversation into active context. A larger window is not a change to model weights or a guarantee of better reasoning.

## Replacement priorities

The [own-component roadmap](OWN_COMPONENTS.md) maps actual dependencies to proposed replacements and measurable completion conditions. Finish Stellan-Run and its tokenizer/serving compatibility first. Then consider completing our MCP compatibility layer and consolidating the portable service into an original native host. Desktop-shell and document-parser rewrites are later, higher-maintenance options. Keep standard cryptography and OS security primitives.
