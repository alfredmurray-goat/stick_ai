import test from "node:test";
import assert from "node:assert/strict";
import { createTokenizer, readTokenizer } from "../tokenizer.mjs";
import { launchPlan, runNative } from "../run.mjs";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promotionFailures } from "../promotion.mjs";

function fixture(merges = ["H e"]) {
  const vocabulary = ["<unk>", "<s>", "</s>", "[INST]", "[/INST]"];
  let extra = 0;
  for (let byte = 0; byte < 256; byte++) {
    const direct = byte >= 33 && byte <= 126 || byte >= 161 && byte <= 172 || byte >= 174;
    vocabulary.push(String.fromCodePoint(direct ? byte : 256 + extra++));
  }
  for (const pair of merges) { const value = pair.replace(" ", ""); if (!vocabulary.includes(value)) { vocabulary.push(value); } }
  return new Map([
    ["tokenizer.ggml.model", "gpt2"],
    ["tokenizer.ggml.pre", "tekken"],
    ["tokenizer.ggml.tokens", vocabulary],
    ["tokenizer.ggml.token_type", vocabulary.map((_, i) => i < 5 ? 3 : 1)],
    ["tokenizer.ggml.merges", merges.length ? merges : ["H e"]],
    ["tokenizer.ggml.bos_token_id", 1],
    ["tokenizer.ggml.eos_token_id", 2]
  ]);
}

test("Tekken uses ranked merges and keeps every Unicode byte", () => {
  const metadata = fixture(["H e", "He l", "Hel l", "Hell o"]);
  const tokenizer = createTokenizer(metadata);
  assert.deepEqual(tokenizer.encode("Hello"), [1, metadata.get("tokenizer.ggml.tokens").indexOf("Hello")]);
  for (const text of ["Hej æøå 😀", "你好世界 Καλημέρα café e\u0301", "\r\n\t  ", "fooBAR_123 //\n", "🙂🙃🎉"]) {
    const ids = tokenizer.encode(text);
    assert.equal(Buffer.concat(ids.map(id => tokenizer.decodeBytes(id))).toString("utf8"), text);
  }
});

test("Tekken does not merge across case and number pretoken boundaries", () => {
  const metadata = fixture(["o B", "1 2", "A B"]);
  const tokenizer = createTokenizer(metadata);
  const ids = tokenizer.encode("fooBar 123 AB");
  assert.ok(!ids.includes(metadata.get("tokenizer.ggml.tokens").indexOf("oB")));
  assert.ok(!ids.includes(metadata.get("tokenizer.ggml.tokens").indexOf("12")));
  assert.ok(ids.includes(metadata.get("tokenizer.ggml.tokens").indexOf("AB")));
});

test("special tokens stay intact and explicit BOS is not doubled", () => {
  const tokenizer = createTokenizer(fixture());
  const ids = tokenizer.encode("<s>[INST] Hello [/INST]");
  assert.equal(ids.filter(id => id === 1).length, 1);
  assert.equal(ids[1], 3);
  assert.equal(ids.at(-1), 4);
  assert.throws(() => tokenizer.decodeBytes(-1));
});

test("RAM gates Lite and Max at 8GB, 15.9GB and 16GB", () => {
  for (const gb of [8, 15.9, 16]) {
    const args = { ramBytes: gb * 1024 ** 3, tokens: [1] };
    assert.equal(launchPlan({ ...args, mode: "llama" }).mode, "llama");
    if (gb < 16) {
      assert.throws(() => launchPlan({ ...args, mode: "gpt2" }), /16 GB/);
      assert.match(launchPlan({ ...args, mode: "gpt2", forceMax: true }).warning, /slow or crash/);
    } else { assert.equal(launchPlan({ ...args, mode: "gpt2" }).warning, null); }
  }
  assert.throws(() => launchPlan({ mode: "llama", ramBytes: 7 * 1024 ** 3, tokens: [1] }), /8 GB/);
  assert.throws(() => launchPlan({ mode: "gpt2", ramBytes: 32 * 1024 ** 3, tokens: [1], maxTokens: 100, context: 50 }), /context/);
});

test("a mismatched executable is rejected before starting a process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stellan-hash-"));
  try {
    const executable = join(directory, "untrusted");
    await writeFile(executable, "not an executable");
    await assert.rejects(runNative({ executable, executableSha256: "0".repeat(64), sha256: "1".repeat(64), model: "missing", prompt: "test" }), /executable hash/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing benchmarks, synthetic hardware and regressions cannot pass promotion", () => {
  assert.ok(promotionFailures({}).length > 0);
  assert.ok(promotionFailures({ format: 1, runs: [] }).some(value => /missing real-model/.test(value)));
  const report = {
    format: 1,
    evidenceCommit: "a".repeat(40),
    securityReviewPassed: true,
    allExistingTestsPassed: true,
    platformPackagesPassed: true,
    integrityAndActivationPassed: true,
    offlineAndApprovalsPassed: true,
    cancellationAndSwapPassed: true,
    contextAndHistoryPassed: true,
    gpuAndFallbackPassed: true,
    noLegacyRuntimeDependency: true,
    runs: []
  };
  for (const target of ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"]) {
    for (const model of ["stellan-1-lite", "stellan-1-max"]) {
      report.runs.push({ target, model, physicalHardware: true, hardwareId: "fixture-only", sameHardware: true, modelSha256: model === "stellan-1-lite" ? "84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e" : "05f00035de8a3893601cec2644f921be240938aab4ff4736ed2f1b6dbcda8dc1", promptSetSha256: "b".repeat(64), sameInputs: true, context: 8192, sameSampling: true, baselineIsShippingConfiguration: true, correctnessPassed: true, agentTasksPassed: true, completedTasks: 20, publicEvidenceUrls: ["https://example.test/fixture"], pairedRepetitions: 5, baseline: { firstTokenMs: 100, tokensPerSecond: 10, cpuSecondsPerTask: 100, peakRssBytes: 100, coldStartMs: 100 }, candidate: { firstTokenMs: 90, tokensPerSecond: 11, cpuSecondsPerTask: 90, peakRssBytes: 90, coldStartMs: 90 } });
    }
  }
  assert.deepEqual(promotionFailures(report), []);
  report.runs[0].physicalHardware = false;
  assert.ok(promotionFailures(report).some(value => /physical/.test(value)));
  report.runs[0].candidate.tokensPerSecond = 9;
  assert.ok(promotionFailures(report).some(value => /faster/.test(value)));
  report.runs[0].candidate.peakRssBytes = 120;
  assert.ok(promotionFailures(report).some(value => /lower CPU/.test(value)));
});

test("actual Max tokenizer metadata matches independent Unicode/code golden cases", { skip: !process.env.STELLAN_TOKENIZER_GGUF }, async () => {
  const reference = JSON.parse(await readFile(new URL("../evidence/tekken-golden.json", import.meta.url), "utf8"));
  const tokenizer = await readTokenizer(process.env.STELLAN_TOKENIZER_GGUF);
  for (const item of reference.cases) { assert.deepEqual(tokenizer.encode(item.prompt), item.ids); }
});


test("Lite accepts the app's long context budget and refuses over-budget requests", () => {
  const options = { mode: "llama", ramBytes: 8 * 1024 ** 3, tokens: Array(65537).fill(1), context: 262144, maxTokens: 128 };
  assert.equal(launchPlan(options).context, 262144);
  assert.throws(() => launchPlan({ ...options, context: 65536 }), /context/);
  assert.throws(() => launchPlan({ ...options, context: 262145 }), /context/);
  assert.throws(() => launchPlan({ ...options, mode: "gpt2", ramBytes: 32 * 1024 ** 3 }), /context/);
});
