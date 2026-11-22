import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requiredTargets = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"];
const requiredModels = ["stellan-1-lite", "stellan-1-max"];
const modelHashes = {
  "stellan-1-lite": "84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e",
  "stellan-1-max": "05f00035de8a3893601cec2644f921be240938aab4ff4736ed2f1b6dbcda8dc1"
};
const positive = value => Number.isFinite(value) && value > 0;

export function promotionFailures(report) {
  const failures = [];
  if (report?.format !== 1 || !Array.isArray(report?.runs)) { return ["A complete benchmark evidence report is required"]; }
  for (const target of requiredTargets) {
    for (const model of requiredModels) {
      const run = report.runs.find(item => item.target === target && item.model === model);
      const name = `${target} ${model}`;
      if (!run) { failures.push(`${name}: missing real-model benchmark`); continue; }
      if (run.physicalHardware !== true || typeof run.hardwareId !== "string" || !run.hardwareId || run.sameHardware !== true) { failures.push(`${name}: physical, matched hardware evidence is required`); }
      if (run.modelSha256 !== modelHashes[model] || !/^[a-f0-9]{64}$/.test(run.promptSetSha256 ?? "") || run.sameInputs !== true || run.context !== 8192 || run.sameSampling !== true || run.baselineIsShippingConfiguration !== true) { failures.push(`${name}: compare identical pinned models, inputs, context, sampling and the shipped baseline settings`); }
      if (run.correctnessPassed !== true || run.agentTasksPassed !== true || !Number.isInteger(run.completedTasks) || run.completedTasks < 20 || run.publicEvidenceUrls?.length < 1 || !Array.isArray(run.publicEvidenceUrls) || !run.publicEvidenceUrls.every(url => typeof url === "string" && url.startsWith("https://"))) { failures.push(`${name}: reproducible model and agent correctness evidence is missing`); }
      if (!Number.isInteger(run.pairedRepetitions) || run.pairedRepetitions < 5) { failures.push(`${name}: at least five paired repetitions are required`); }
      const current = run.baseline;
      const next = run.candidate;
      const fields = ["firstTokenMs", "tokensPerSecond", "cpuSecondsPerTask", "peakRssBytes", "coldStartMs"];
      if (!current || !next || !fields.every(field => positive(current[field]) && positive(next[field]))) { failures.push(`${name}: complete timing and resource measurements are required`); continue; }
      if (next.firstTokenMs > current.firstTokenMs * 0.95 || next.tokensPerSecond < current.tokensPerSecond * 1.05 || next.coldStartMs > current.coldStartMs) { failures.push(`${name}: faster replies and generation without a cold-start regression are not established`); }
      if (next.cpuSecondsPerTask > current.cpuSecondsPerTask * 0.95 || next.peakRssBytes > current.peakRssBytes * 0.95) { failures.push(`${name}: lower CPU work and peak resident memory are not established`); }
    }
  }
  for (const check of ["securityReviewPassed", "allExistingTestsPassed", "platformPackagesPassed", "integrityAndActivationPassed", "offlineAndApprovalsPassed", "cancellationAndSwapPassed", "contextAndHistoryPassed", "gpuAndFallbackPassed", "noLegacyRuntimeDependency"]) {
    if (report[check] !== true) { failures.push(`${check}: missing validation`); }
  }
  if (typeof report.evidenceCommit !== "string" || !/^[a-f0-9]{40}$/.test(report.evidenceCommit)) { failures.push("Benchmark evidence must identify the exact candidate commit"); }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = JSON.parse(await readFile(process.argv[2], "utf8"));
    const failures = promotionFailures(report);
    process.stdout.write(JSON.stringify({ eligibleForReview: failures.length === 0, failures }, null, 2) + "\n");
    process.exitCode = failures.length ? 1 : 0;
  } catch {
    process.stderr.write("Supply a complete benchmark evidence report before considering promotion\n");
    process.exitCode = 1;
  }
}
