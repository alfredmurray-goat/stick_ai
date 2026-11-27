import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import ignore from "ignore";

// Host's .gitignore matcher (src/gitignore.cpp) against the `ignore` package it replaces, on fixed cases and on
// thousands of generated rule sets and paths (a seeded generator, so a failure always reproduces).
const host = process.env.STELLAN_TEST_HOST ?? resolve(`native-host-app/${process.platform === "win32" ? "Release/stellan-host.exe" : "stellan-host"}`);
const ready = existsSync(host);
if (process.env.STELLAN_REQUIRE_NATIVE_HOST === "1" && !ready) { throw new Error(`The native host is missing (${host})`); }

function expected(rules: string[], paths: string[]): unknown {
  const matcher = ignore(); for (const rule of rules) { matcher.add(rule); }
  return paths.map((path) => { try { return matcher.ignores(path); } catch { return "error"; } });
}
function native(batches: { rules: string[]; paths: string[] }[]): unknown[] {
  // One Host run per batch keeps it simple; batches are grouped to keep the test fast.
  return batches.map((batch) => JSON.parse(spawnSync(host, ["--gitignore-check"], { input: JSON.stringify(batch), encoding: "utf8" }).stdout));
}

it.skipIf(!ready)("matches the ignore package on hand-picked .gitignore rules", () => {
  const batches = [
    { rules: ["*.log\n/build/\n!keep.log\ndocs/**/*.md\n"], paths: ["a.log", "keep.log", "build/", "src/build/", "docs/x/y.md", "docs/y.md", "README.md"] },
    { rules: ["node_modules\n.env*\n!.env.example\n# comment\n\\#hash\n\\!bang\n"], paths: ["node_modules/", "a/node_modules/x.js", ".env", ".env.local", ".env.example", "#hash", "!bang", "comment"] },
    { rules: ["foo/\nbar\n/baz\nqux/*\n**/deep\na/**/b\n"], paths: ["foo", "foo/", "x/foo/", "bar", "x/bar", "baz", "x/baz", "qux/a", "qux/a/b", "q/deep", "deep/", "a/b", "a/x/y/b", "A/B"] },
    { rules: ["file\\ name\ntrailing   \nescaped\\ \n[abc].txt\n[!a].md\n[a-c]x\n?.js\n"], paths: ["file name", "trailing", "escaped ", "a.txt", "d.txt", "b.md", "a.md", "bx", "dx", "x.js", "xy.js"] },
    { rules: ["*\n!*/\n!*.ts\n"], paths: ["a.js", "a.ts", "src/", "src/a.ts", "src/a.js"] },
    { rules: ["docs/\n!docs/keep.md\n"], paths: ["docs/", "docs/keep.md", "docs/other.md"] },
    { rules: ["a\r\nb\r\n"], paths: ["a", "b", "c"] },
    { rules: ["\\\n*\\\n"], paths: ["a"] },
    { rules: ["**/*.min.js\n**\n!**/\n"], paths: ["a.min.js", "x/a.min.js", "x/", "x/y.js"] },
    { rules: ["*.LOG"], paths: ["a.log", "A.LOG"] }
  ];
  const actual = native(batches);
  batches.forEach((batch, i) => { expect(actual[i], JSON.stringify(batch.rules)).toEqual(expected(batch.rules, batch.paths)); });
});

it.skipIf(!ready)("matches the ignore package on generated rule sets and paths", () => {
  let seed = Number(process.env.STICK_FUZZ_SEED ?? 20261127);
  const count = Number(process.env.STICK_FUZZ_BATCHES ?? 600);
  const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  const pick = <T>(items: readonly T[]): T => items[random(items.length)]!;
  const names = ["a", "b", "src", "build", "x.log", "README.md", "Foo", "test.ts", "dist", "node_modules", ".env", "a b", "doc"] as const;
  const tokens = ["*", "**", "?", "[a-c]", "[!a]", "[^b]", "\\*", "\\?", "\\[", "*.log", "*.md", "x", ".", "-", "[z-a]", "[]", "[", "\\\\"] as const;
  function pattern(): string {
    let p = "";
    if (random(5) === 0) p += "!";
    if (random(4) === 0) p += "/";
    const parts = 1 + random(3);
    for (let i = 0; i < parts; i++) { if (i) p += "/"; p += random(2) ? pick(names) : pick(tokens); if (random(4) === 0) p += pick(tokens); }
    if (random(4) === 0) p += "/";
    if (random(8) === 0) p += pick(["   ", "\\ ", " \\ ", "\t"]);
    if (random(12) === 0) p = "#" + p;
    if (random(15) === 0) p = "\\" + p;
    return p;
  }
  function path(): string {
    const depth = 1 + random(4); const parts = Array.from({ length: depth }, () => random(3) ? pick(names) : pick(["x.min.js", "y", "Z", "a.md", "deep", "b c", "[a]", "q?"]));
    return parts.join("/") + (random(3) === 0 ? "/" : "");
  }
  const batches = Array.from({ length: count }, () => ({ rules: Array.from({ length: 1 + random(3) }, () => Array.from({ length: 1 + random(6) }, pattern).join(random(6) === 0 ? "\r\n" : "\n")), paths: Array.from({ length: 12 }, path) }));
  const actual = native(batches);
  let compared = 0;
  batches.forEach((batch, i) => { expect(actual[i], JSON.stringify(batch)).toEqual(expected(batch.rules, batch.paths)); compared += batch.paths.length; });
  expect(compared).toBe(count * 12);
}, 120000);
