import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseSkill } from "../src/portable/skills.js";

// Host's SKILL.md reader (stellan-host --parse-skill) against parseSkill and the `yaml` package it replaces:
// the same skill, or the same refusal, for every header.
const host = process.env.STELLAN_TEST_HOST ?? resolve(`native-host-app/${process.platform === "win32" ? "Release/stellan-host.exe" : "stellan-host"}`);
const ready = existsSync(host);
if (process.env.STELLAN_REQUIRE_NATIVE_HOST === "1" && !ready) { throw new Error(`The native host is missing (${host})`); }

function node(text: string, fallback: string): unknown { try { return parseSkill(text, fallback); } catch (error) { return { error: (error as Error).message }; } }
function native(text: string, fallback: string): unknown { return JSON.parse(spawnSync(host, ["--parse-skill", fallback], { input: text, encoding: "utf8" }).stdout); }

const body = "\n# Title\n\nDo the thing carefully.\n";
export const headers: Record<string, string> = {
  "plain": `---\nname: review-code\ndescription: Review code for bugs.\n---${body}`,
  "no header": `# Heading only\n\nInstructions here.\n`,
  "crlf": `---\r\nname: crlf-skill\r\ndescription: Windows line endings\r\n---\r\nBody text\r\n`,
  "bom": `\uFEFF---\nname: bom-skill\ndescription: With a byte order mark\n---${body}`,
  "double quoted": `---\nname: "quoted"\ndescription: "Uses \\"quotes\\", a tab\\t and \\u00e9"\n---${body}`,
  "single quoted": `---\nname: 'single'\ndescription: 'It''s fine: really'\n---${body}`,
  "folded": `---\nname: folded\ndescription: >\n  First line\n  continues here.\n\n  New paragraph.\n---${body}`,
  "literal": `---\nname: literal\ndescription: |\n  Line one\n  Line two\n---${body}`,
  "literal strip": `---\nname: literal-strip\ndescription: |-\n  Kept\n\n---${body}`,
  "plain multi-line": `---\nname: multi\ndescription: This description\n  wraps onto a second line\n  and a third.\n---${body}`,
  "comments": `---\n# a comment\nname: commented # trailing\ndescription: Has comments # here\n---${body}`,
  "booleans": `---\nname: flags\ndescription: Flags\ndisable-model-invocation: true\nuser-invocable: false\n---${body}`,
  "boolean spellings": `---\nname: flags-two\ndescription: Flags\ndisable-model-invocation: True\nuser-invocable: FALSE\n---${body}`,
  "boolean as text": `---\nname: flags-three\ndescription: Flags\ndisable-model-invocation: "true"\nuser-invocable: no\n---${body}`,
  "list and map": `---\nname: lists\ndescription: Lists\nallowed-tools:\n  - Read\n  - Grep\nmetadata:\n  version: 1\n  owner: someone\n---${body}`,
  "flow list": `---\nname: flow\ndescription: Flow\nallowed-tools: [Read, "Grep", 'Edit']\nextra: {a: 1, b: [2, 3]}\n---${body}`,
  "number description": `---\nname: numeric\ndescription: 12345\n---${body}`,
  "null description": `---\nname: nothing\ndescription: ~\n---${body}`,
  "empty description": `---\nname: empty\ndescription:\n---${body}`,
  "name from folder": `---\ndescription: Uses the folder name\n---${body}`,
  "bad name": `---\nname: Bad Name\ndescription: x\n---${body}`,
  "long name": `---\nname: ${"a".repeat(65)}\ndescription: x\n---${body}`,
  "alias": `---\nname: &n aliased\ndescription: *n\n---${body}`,
  "duplicate key": `---\nname: dup\nname: dup-again\ndescription: x\n---${body}`,
  "colon in plain value": `---\nname: colon\ndescription: Use this: when needed\n---${body}`,
  "colon without space": `---\nname: colon-ok\ndescription: Times like 10:30 and URLs https://example.com work\n---${body}`,
  "top-level list": `---\n- a\n- b\n---${body}`,
  "comment-only header": `---\n# nothing\n---${body}`,
  "empty header": `---\n---${body}`,
  "unclosed header": `---\nname: open\ndescription: never closed\n${body}`,
  "no body": `---\nname: nobody\ndescription: x\n---\n`,
  "spaces in description": `---\nname: spaces\ndescription: "  lots\\n\\n of   space\\t here  "\n---${body}`,
  "unicode": `---\nname: unicode\ndescription: Café, naïve, 日本語 and 🦈\n---${body}`,
  "unclosed quote": `---\nname: broken\ndescription: "never closed\n---${body}`,
  "hash in value": `---\nname: hash\ndescription: C# and F#are languages\n---${body}`,
  "keep chomping": `---\nname: keep\ndescription: |+\n  Keep\n\n---${body}`,
  "indented header line": `---\n  name: indented\ndescription: x\n---${body}`,
  "dashes inside body": `---\nname: dashes\ndescription: x\n---\nText\n---\nMore text\n`,
  "too large": `---\nname: big\ndescription: x\n---\n${"x".repeat(70000)}`
};

it.skipIf(!ready)("reads SKILL.md headers exactly as the app's YAML reader does", () => {
  for (const [name, text] of Object.entries(headers)) { expect(native(text, "folder-name"), name).toEqual(node(text, "folder-name")); }
});

// Real skill packs, when the machine has some (the app scans ~/.claude/skills and ~/.agents/skills the same way).
const roots = [process.env.STICK_TEST_SKILLS, "/mnt/skills"].filter((path): path is string => Boolean(path && existsSync(path)));
function files(root: string, depth = 0): string[] {
  if (depth > 4) return [];
  return readdirSync(root).flatMap((entry) => { const path = join(root, entry); const info = statSync(path); return info.isDirectory() ? files(path, depth + 1) : entry === "SKILL.md" ? [path] : []; });
}
it.skipIf(!ready || roots.length === 0)("reads every real skill pack on this machine exactly as the app does", () => {
  const all = roots.flatMap((root) => files(root));
  for (const path of all) { const text = readFileSync(path, "utf8"); const fallback = basename(dirname(path)); expect(native(text, fallback), path).toEqual(node(text, fallback)); }
  expect(all.length).toBeGreaterThan(0);
});
