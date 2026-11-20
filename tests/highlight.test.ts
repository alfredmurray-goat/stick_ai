import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const context: { stickHighlight?: { tokenize(code: string, language?: string): [string | null, string][]; family(language?: string): string } } = {};
runInNewContext(readFileSync("portable/ui/highlight.js", "utf8"), context);
const { tokenize, family } = context.stickHighlight!;
const classOf = (tokens: [string | null, string][], text: string) => tokens.find(([, value]) => value === text)?.[0] ?? null;

describe("syntax highlighting", () => {
  const samples: [string, string][] = [
    ["ts", "// greet\nexport async function greet(name: string): Promise<string> {\n  const n = 42 + 0x1f;\n  return `hi ${name}` + 'x';\n}\n/* unterminated"],
    ["python", "@cache\ndef add(a, b):\n    \"\"\"Add.\"\"\"\n    return a + b  # sum\nprint(add(1, 2.5), None)\n'''open"],
    ["bash", "#!/bin/sh\nexport PATH=\"$HOME/bin:$PATH\"\nif [ -f x ]; then echo ${NAME} --verbose; fi # done"],
    ["json", "{\n  \"name\": \"stick\",\n  \"size\": 14.3,\n  \"ok\": true, \"none\": null\n}"],
    ["css", "/* c */\n.a { color: #fff; margin: 4px; }\n@media (min-width: 600px) { b { font: 'x'; } }"],
    ["html", "<!-- c -->\n<a href=\"/x\" class='y'>link</a><br/>"],
    ["yaml", "# c\nname: stick\nversion: 1.2\nenabled: true\n- item: \"x\""],
    ["sql", "SELECT id, name FROM users WHERE age > 18 -- adults\nAND name LIKE 'A%';"],
    ["whatever", "plain \"text\" 12"],
    ["", "no language at all"]
  ];
  it.each(samples)("keeps %s text exactly", (language, code) => {
    expect(tokenize(code, language).map(([, text]) => text).join("")).toBe(code);
  });
  it("colours keywords, strings, numbers, comments, functions and types", () => {
    const ts = tokenize(samples[0][1], "ts");
    expect(classOf(ts, "// greet")).toBe("tok-com");
    expect(classOf(ts, "export")).toBe("tok-kw");
    expect(classOf(ts, "greet")).toBe("tok-fn");
    expect(classOf(ts, "string")).toBe("tok-type");
    expect(classOf(ts, "Promise")).toBe("tok-type");
    expect(classOf(ts, "42")).toBe("tok-num");
    expect(classOf(ts, "`hi ${name}`")).toBe("tok-str");
    expect(classOf(ts, "name")).toBe(null);
    const py = tokenize(samples[1][1], "py");
    expect(classOf(py, "def")).toBe("tok-kw");
    expect(classOf(py, "add")).toBe("tok-fn");
    expect(classOf(py, "@cache")).toBe("tok-attr");
    expect(classOf(py, "# sum")).toBe("tok-com");
    const json = tokenize(samples[3][1], "json");
    expect(classOf(json, "\"name\"")).toBe("tok-key");
    expect(classOf(json, "\"stick\"")).toBe("tok-str");
    expect(classOf(json, "true")).toBe("tok-lit");
    const sh = tokenize(samples[2][1], "bash");
    expect(classOf(sh, "$HOME")).toBe(null); // inside a string, which wins
    expect(classOf(sh, "${NAME}")).toBe("tok-var");
    expect(classOf(sh, "--verbose")).toBe("tok-attr");
    expect(classOf(sh, "# done")).toBe("tok-com");
    expect(classOf(tokenize(samples[7][1], "sql"), "SELECT")).toBe("tok-kw");
  });
  it("leaves unknown languages mostly plain and huge blocks untouched", () => {
    expect(family("TypeScript")).toBe("c");
    expect(family("brainfuck")).toBe("plain");
    expect(tokenize("x".repeat(200001), "js")).toEqual([[null, "x".repeat(200001)]]);
    expect(tokenize("no language at all", "")).toEqual([[null, "no language at all"]]);
  });
  it("is fast enough to re-run while an answer streams", () => {
    const code = samples[0][1].repeat(400);
    const start = performance.now(); tokenize(code, "ts");
    expect(performance.now() - start).toBeLessThan(500);
  });
});
