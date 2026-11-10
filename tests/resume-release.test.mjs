import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveName, recordFromHelper, releasePlatforms } from "../scripts/resume-release.mjs";
import { joinHelper } from "../scripts/release-parts.mjs";
const a = "a".repeat(64), b = "b".repeat(64), whole = "f".repeat(64);
function fixture(platform) {
  const name = archiveName(platform);
  const parts = [{ name: name + ".part01", size: 2000 * 1024 ** 2, sha256: a }, { name: name + ".part02", size: 1234, sha256: b }];
  return { name, size: parts.reduce((sum, part) => sum + part.size, 0), sha256: whole, parts };
}
function assets(record) { return record.parts.map((part) => ({ ...part, state: "uploaded", digest: `sha256:${part.sha256}` })); }
it.each(releasePlatforms)("recovers %s only from its complete helper and matching uploaded part hashes", async (platform) => {
  const directory = await mkdtemp(join(tmpdir(), "stick-resume-test-"));
  try {
    const record = fixture(platform); const helper = await joinHelper(record, directory, platform);
    const text = await readFile(join(directory, helper), "utf8");
    expect(recordFromHelper(platform, text, assets(record))).toEqual(record);
    expect(recordFromHelper(platform, text, assets(record).slice(1))).toBeUndefined();
    expect(recordFromHelper(platform, text, assets(record).map((part) => ({ ...part, digest: `sha256:${whole}` })))).toBeUndefined();
    expect(recordFromHelper(platform, text, assets(record).map((part) => ({ ...part, state: "new" })))).toBeUndefined();
    expect(recordFromHelper(platform, text, [...assets(record), { name: record.name + ".part03" }])).toBeUndefined();
    expect(recordFromHelper(platform, text.replaceAll(whole, "invalid"), assets(record))).toBeUndefined();
    expect(recordFromHelper(platform, text + text, assets(record))).toBeUndefined();
    expect(recordFromHelper("other-platform", text, assets(record))).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it.each([
  { isDraft: false },
  { targetCommitish: "other-source" },
  { apiUrl: "https://api.github.com/repos/other/repo/releases/123" },
  { apiUrl: "https://api.github.com/repos/owner/repo/releases/not-a-release-id" }
])("refuses to resume a different or published release", async (change) => {
  const { completedReleasePlatforms } = await import("../scripts/resume-release.mjs");
  const view = { isDraft: true, targetCommitish: "source", apiUrl: "https://api.github.com/repos/owner/repo/releases/123", ...change };
  let calls = 0;
  await expect(completedReleasePlatforms("owner/repo", "desktop-123", "source", "/unused", async () => { calls++; return JSON.stringify(view); })).rejects.toThrow("Refusing to resume");
  expect(calls).toBe(1);
});
