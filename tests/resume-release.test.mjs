import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

it("finds completed uploads from the dedicated asset endpoint when the release summary is stale", async () => {
  const { completedReleasePlatforms, helperName } = await import("../scripts/resume-release.mjs");
  const temporary = await mkdtemp(join(tmpdir(), "stick-fresh-assets-"));
  try {
    const record = fixture("windows-x64"), helper = await joinHelper(record, temporary, "windows-x64");
    const helperBytes = await readFile(join(temporary, helper));
    const metadata = [...assets(record), { id: 123, size: helperBytes.length, name: helperName("windows-x64"), state: "uploaded", digest: `sha256:${createHash("sha256").update(helperBytes).digest("hex")}` }];
    const apiUrl = "https://api.github.com/repos/owner/repo/releases/123";
    const gh = async (...args) => {
      if (args[0] === "release" && args[1] === "view") { return JSON.stringify({ isDraft: true, targetCommitish: "source", apiUrl, assets: [] }); }
      if (args[0] === "api" && args[1] === apiUrl + "/assets?per_page=100") { return JSON.stringify(metadata); }
      if (args[0] === "release" && args[1] === "download") {
        const output = args[args.indexOf("--dir") + 1]; await copyFile(join(temporary, helper), join(output, helper)); return "";
      }
      throw new Error(`Unexpected request: ${args.join(" ")}`);
    };
    const completed = await completedReleasePlatforms("owner/repo", "desktop-123", "source", temporary, gh, async (_repo, _asset, path) => copyFile(join(temporary, helper), path));
    expect([...completed.keys()]).toEqual(["windows-x64"]); expect(completed.get("windows-x64")).toEqual(record);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
