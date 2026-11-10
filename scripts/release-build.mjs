import { setTimeout as delay } from "node:timers/promises";

// An explicit dispatch can start while the caller's final dispatch job is closing.
// Recheck provenance on every poll and publish only after the whole build succeeds.
export async function successfulDesktopBuild(repo, runId, gh, wait = () => delay(2000), attempts = 61) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const run = JSON.parse(await gh("api", `repos/${repo}/actions/runs/${runId}`));
    if (run.head_branch !== "main" || run.path !== ".github/workflows/desktop.yml" || run.head_repository?.full_name !== repo || !["push", "workflow_dispatch"].includes(run.event)) {
      throw new Error("Only successful trusted main desktop builds can be released");
    }
    if (run.status === "completed") {
      if (run.conclusion !== "success") { throw new Error("Only successful trusted main desktop builds can be released"); }
      return run;
    }
    if (attempt + 1 < attempts) { await wait(); }
  }
  throw new Error("Desktop build has not completed successfully; retry publication after it finishes");
}
