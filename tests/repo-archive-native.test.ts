import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { repositoryFiles, useHostRepositoryFiles, verifiedFiles } from "../src/portable/github-workspace.js";
import { GitHubError, type GitHubTreeEntry } from "../src/portable/github-client.js";

// Host's GitHub archive reader (src/repo_archive.cpp, --repository-files) against the app's repositoryFiles: the same
// files or the same refusal for genuine, tampered, incomplete and hostile archives.
const host = process.env.STELLAN_TEST_HOST ?? resolve(`native-host-app/${process.platform === "win32" ? "Release/stellan-host.exe" : "stellan-host"}`);
const ready = existsSync(host);
if (process.env.STELLAN_REQUIRE_NATIVE_HOST === "1" && !ready) { throw new Error(`The native host is missing (${host})`); }

const blob = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Outcome = { files: [string, string][] } | { error: string } | "other";

function node(archive: Buffer, tree: GitHubTreeEntry[]): Outcome {
  try { return { files: [...repositoryFiles(archive, tree)].map(([path, bytes]) => [path, digest(bytes)]) }; }
  catch (error) { return error instanceof GitHubError ? { error: error.message } : "other"; }
}
function native(archive: Buffer, tree: GitHubTreeEntry[]): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "stick-repo-native-"));
  try {
    writeFileSync(join(dir, "archive.zip"), archive);
    const run = spawnSync(host, ["--repository-files", join(dir, "out")], { input: JSON.stringify({ archive: join(dir, "archive.zip"), tree }), encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
    const reply = JSON.parse(run.stdout);
    if (reply.error) { return reply.github ? { error: reply.error } : "other"; }
    return { files: (reply.files as string[]).map((path) => [path, digest(readFileSync(join(dir, "out", path)))]) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function repo(files: Record<string, string | Buffer>, options: { prefix?: string; level?: 0 | 9; dirs?: boolean } = {}) {
  const prefix = options.prefix ?? "owner-repo-abc1234";
  const zip: Zippable = {};
  if (options.dirs !== false) { zip[`${prefix}/`] = new Uint8Array(); }
  const tree: GitHubTreeEntry[] = [];
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    if (options.dirs !== false) { const parts = path.split("/"); for (let i = 1; i < parts.length; i++) { zip[`${prefix}/${parts.slice(0, i).join("/")}/`] = new Uint8Array(); } }
    zip[`${prefix}/${path}`] = [new Uint8Array(bytes), { level: options.level ?? 6 }];
    tree.push({ path, mode: "100644", type: "blob", sha: blob(bytes), size: bytes.length } as GitHubTreeEntry);
  }
  return { archive: Buffer.from(zipSync(zip)), tree };
}

it.skipIf(!ready)("reads GitHub archives exactly as the app does, and refuses the same bad ones", () => {
  const big = Buffer.alloc(300000); for (let i = 0; i < big.length; i++) { big[i] = (i * 7919) % 251; }
  const good = repo({ "README.md": "# Hello\n", "src/index.ts": "export const x = 1;\n".repeat(200), "src/deep/a b.txt": "spaces", "bin/data.bin": big, "empty.txt": "", "ünïcode/naïve.md": "café" });
  const cases: [string, Buffer, GitHubTreeEntry[]][] = [["genuine", good.archive, good.tree]];
  const stored = repo({ "a.txt": "stored", "b/c.txt": "x".repeat(5000) }, { level: 0 }); cases.push(["stored entries", stored.archive, stored.tree]);
  const noDirs = repo({ "a.txt": "a", "x/y/z.txt": "z" }, { dirs: false }); cases.push(["no directory entries", noDirs.archive, noDirs.tree]);
  // A tampered file: the archive holds different bytes from the pinned commit.
  cases.push(["tampered", repo({ "a.txt": "evil" }).archive, repo({ "a.txt": "good" }).tree]);
  // export-ignore: a tracked file missing from the archive.
  cases.push(["missing file", repo({ "a.txt": "a" }).archive, [...repo({ "a.txt": "a" }).tree, { path: "gone.txt", mode: "100644", type: "blob", sha: blob(Buffer.from("gone")) } as GitHubTreeEntry]]);
  cases.push(["extra file", repo({ "a.txt": "a", "b.txt": "b" }).archive, repo({ "a.txt": "a" }).tree]);
  cases.push(["symlink in tree", good.archive, [...good.tree, { path: "link", mode: "120000", type: "blob", sha: "0".repeat(40) } as GitHubTreeEntry]]);
  cases.push(["submodule", good.archive, [...good.tree, { path: "vendor", mode: "160000", type: "commit", sha: "0".repeat(40) } as GitHubTreeEntry]]);
  for (const bad of [".git/config", "a/../b", "CON", "lpt1.txt", "x/aux.c", "trail.", "trail ", "a:b", "q?.md", ".STICK/x", "com0", "comX.txt", "nul.tar.gz", "Ä/.Git"]) {
    const r = repo({ [bad]: "x" }, { dirs: false }); cases.push([`unsafe ${bad}`, r.archive, r.tree]);
  }
  const twoTops = repo({ "a.txt": "a" }); const other = repo({ "b.txt": "b" }, { prefix: "other-top" });
  cases.push(["two top folders", Buffer.from(zipSync({ "one/a.txt": new TextEncoder().encode("a"), "two/b.txt": new TextEncoder().encode("b") })), [...twoTops.tree, ...other.tree]]);
  cases.push(["file at top", Buffer.from(zipSync({ "loose.txt": new TextEncoder().encode("a") })), repo({ "loose.txt": "a" }).tree]);
  cases.push(["case collision", Buffer.from(zipSync({ "p/a.txt": new TextEncoder().encode("a"), "p/A.txt": new TextEncoder().encode("A") })), [...repo({ "a.txt": "a" }).tree, ...repo({ "A.txt": "A" }).tree]]);
  cases.push(["unicode case collision", Buffer.from(zipSync({ "p/Über.md": new TextEncoder().encode("1"), "p/über.md": new TextEncoder().encode("2") })), [...repo({ "Über.md": "1" }).tree, ...repo({ "über.md": "2" }).tree]]);
  cases.push(["backslash", Buffer.from(zipSync({ "p\\a.txt": new TextEncoder().encode("a") })), repo({ "a.txt": "a" }).tree]);
  const huge = repo({ "huge.bin": Buffer.alloc(8 * 1024 ** 2 + 1) }); cases.push(["file over 8 MB", huge.archive, huge.tree]);
  const empty = repo({}); cases.push(["empty repository", empty.archive, empty.tree]);
  cases.push(["not a zip", Buffer.from("definitely not a zip file"), good.tree]);
  for (const [name, archive, tree] of cases) {
    expect(native(archive, tree), name).toEqual(node(archive, tree));
  }
  // Damaged archives: fflate and Host give up at different points inside broken compressed data, so the message can
  // differ, but both must refuse; never accept a file the commit doesn't have.
  let seed = Number(process.env.STICK_FUZZ_SEED ?? 7);
  const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  for (let i = 0; i < Number(process.env.STICK_FUZZ_BATCHES ?? 300); i++) {
    const damaged = Buffer.from(good.archive);
    const at = random(damaged.length), length = 1 + random(i % 3 === 0 ? 64 : 4);
    for (let k = at; k < Math.min(damaged.length, at + length); k++) { damaged[k] = random(256); }
    const expected = node(damaged, good.tree), actual = native(damaged, good.tree);

    if (typeof expected === "object" && "files" in expected) { expect(actual, `damage at ${at}`).toEqual(expected); } else { expect(actual, `damage at ${at}`).not.toHaveProperty("files"); }
  }
  expect(node(good.archive, good.tree)).toHaveProperty("files");
}, 60000);

it.skipIf(!ready)("the app uses Host for archives, with the same files and the same refusals", async () => {
  const good = repo({ "README.md": "hi", "src/a.ts": "export {}\n", "ünï/b.md": "x" });
  try {
    useHostRepositoryFiles(host);
    expect([...await verifiedFiles(good.archive, good.tree, new AbortController().signal)]).toEqual([...repositoryFiles(good.archive, good.tree)]);
    const bad = repo({ "a.txt": "evil" });
    await expect(verifiedFiles(bad.archive, repo({ "a.txt": "good" }).tree, new AbortController().signal)).rejects.toThrow(GitHubError);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(verifiedFiles(good.archive, good.tree, cancelled.signal)).rejects.toBeTruthy();
  } finally { useHostRepositoryFiles(undefined); }
});
