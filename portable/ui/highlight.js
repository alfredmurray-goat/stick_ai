// Syntax highlighting for code in answers. Built in because the CSP allows no external scripts.
// tokenize() is pure (text in, [class, text] pairs out) so it can be tested without a DOM; highlightInto()
// builds text nodes and spans, never HTML, so model output can't inject markup.
(function (scope) {
  "use strict";
  const words = (list) => new Set(list.split(" "));
  const C_LIKE = words("abstract as async await break case catch class const continue debugger default defer delete do else enum export extends extern false final finally fn for from func function go goto if impl implements import in instanceof interface internal let loop match mod module move mut namespace new nil null of override package private protected pub public readonly ref return self Self static struct super switch this throw throws trait true try type typeof union unsafe use using var virtual void volatile where while with yield");
  const TYPES = words("bool boolean byte char double float i8 i16 i32 i64 i128 isize int long number object short string str u8 u16 u32 u64 u128 usize uint any never unknown undefined void Vec String Option Result Promise Array Map Set Record");
  const PYTHON = words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self cls print");
  const SHELL = words("if then else elif fi for while until do done case esac in function return local export source alias echo cd exit set unset readonly shift test true false sudo");
  const SQL = words("select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer full on as group by order having limit offset distinct union all null is in like between case when then else end primary key foreign references default unique exists returning with");
  const families = {
    c: ["js", "javascript", "mjs", "cjs", "jsx", "ts", "typescript", "tsx", "java", "c", "h", "cpp", "c++", "cc", "hpp", "cs", "csharp", "go", "golang", "rust", "rs", "swift", "kotlin", "kt", "php", "dart", "scala", "groovy", "zig"],
    python: ["py", "python", "python3"],
    shell: ["sh", "bash", "zsh", "shell", "console", "fish", "powershell", "ps1", "bat", "cmd"],
    json: ["json", "jsonc", "json5"],
    css: ["css", "scss", "sass", "less"],
    markup: ["html", "xml", "svg", "vue", "svelte", "xhtml"],
    yaml: ["yaml", "yml", "toml", "ini", "conf", "dockerfile", "makefile", "env"],
    sql: ["sql", "postgres", "postgresql", "mysql", "sqlite"]
  };
  function family(language) {
    const name = String(language || "").trim().toLowerCase();
    for (const [key, names] of Object.entries(families)) { if (names.includes(name)) { return key; } }
    return "plain";
  }
  // One sticky regex per family; each alternative is a named group that maps to a CSS class.
  const NUMBER = String.raw`(?<num>\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]{0,3}\b)`;
  const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`, SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`;
  const patterns = {
    c: new RegExp(String.raw`(?<com>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<str>\x60(?:[^\x60\\]|\\[\s\S])*\x60?|${DQ}|${SQ})|${NUMBER}|(?<word>[A-Za-z_$][\w$]*)|(?<attr>@[A-Za-z_][\w.]*|#\[[^\]\n]*\]?)`, "gy"),
    python: new RegExp(String.raw`(?<com>#[^\n]*)|(?<str>[rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${DQ}|${SQ}))|${NUMBER}|(?<attr>@[A-Za-z_][\w.]*)|(?<word>[A-Za-z_]\w*)`, "gy"),
    shell: new RegExp(String.raw`(?<com>(?:^|(?<=\s))#[^\n]*)|(?<str>${DQ}|${SQ})|(?<var>\$\{[^}\n]*\}?|\$[A-Za-z_][\w]*|\$[0-9@#?*$!-])|(?<attr>(?<=\s)--?[A-Za-z][\w-]*)|${NUMBER}|(?<word>[A-Za-z_][\w-]*)`, "gmy"),
    json: new RegExp(String.raw`(?<com>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<key>${DQ}(?=\s*:))|(?<str>${DQ})|${NUMBER}|(?<lit>\b(?:true|false|null)\b)`, "gy"),
    css: new RegExp(String.raw`(?<com>\/\*[\s\S]*?(?:\*\/|$))|(?<str>${DQ}|${SQ})|(?<attr>@[\w-]+|#[\da-fA-F]{3,8}\b)|(?<key>[\w-]+(?=\s*:[^:]))|${NUMBER}`, "gy"),
    markup: new RegExp(String.raw`(?<com><!--[\s\S]*?(?:-->|$))|(?<tag><\/?[A-Za-z][\w:.-]*|\/?>)|(?<str>${DQ}|${SQ})|(?<key>[A-Za-z_:][\w:.-]*(?==))`, "gy"),
    yaml: new RegExp(String.raw`(?<com>#[^\n]*)|(?<key>^[ \t-]*[A-Za-z_][\w.-]*(?=\s*[:=])|^\[[^\]\n]*\])|(?<str>${DQ}|${SQ})|(?<lit>\b(?:true|false|null|yes|no|on|off)\b)|${NUMBER}`, "gmy"),
    sql: new RegExp(String.raw`(?<com>--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<str>${SQ}|${DQ})|${NUMBER}|(?<word>[A-Za-z_]\w*)`, "giy"),
    plain: new RegExp(String.raw`(?<str>${DQ}|${SQ})|${NUMBER}`, "gy")
  };
  const classes = { com: "tok-com", str: "tok-str", num: "tok-num", attr: "tok-attr", var: "tok-var", key: "tok-key", lit: "tok-lit", tag: "tok-tag" };
  function wordClass(kind, word, call, previous) {
    if (kind === "c") {
      if (C_LIKE.has(word)) { return "tok-kw"; }
      if (TYPES.has(word) || /^[A-Z][a-z0-9]+[A-Z0-9]?\w*$/.test(word) && word.length > 1) { return "tok-type"; }
      if (call) { return "tok-fn"; }
      return null;
    }
    if (kind === "python") {
      if (PYTHON.has(word)) { return "tok-kw"; }
      if (/^(def|class)$/.test(previous)) { return "tok-fn"; }
      if (call) { return "tok-fn"; }
      if (/^[A-Z][a-z]\w*$/.test(word)) { return "tok-type"; }
      return null;
    }
    if (kind === "shell") { return SHELL.has(word) ? "tok-kw" : null; }
    if (kind === "sql") { return SQL.has(word.toLowerCase()) ? "tok-kw" : null; }
    return null;
  }
  /** Splits code into [className | null, text] pairs that join back to exactly the input. */
  function tokenize(code, language) {
    const text = String(code);
    const kind = family(language);
    // Very long blocks stay plain so streaming large answers stays fast.
    if (kind === "plain" && !language || text.length > 200000) { return [[null, text]]; }
    const pattern = patterns[kind]; const out = []; let plain = ""; let index = 0; let previous = "";
    const push = (cls, value) => { if (cls) { if (plain) { out.push([null, plain]); plain = ""; } out.push([cls, value]); } else { plain += value; } };
    while (index < text.length) {
      pattern.lastIndex = index;
      const match = pattern.exec(text);
      if (!match || match[0] === "") { plain += text[index]; index++; continue; }
      const groups = match.groups;
      if (groups.word !== undefined) {
        const call = /^\s*\(/.test(text.slice(index + groups.word.length, index + groups.word.length + 40));
        push(wordClass(kind, groups.word, call, previous), groups.word); previous = groups.word;
      } else {
        const name = Object.keys(classes).find((key) => groups[key] !== undefined);
        push(name ? classes[name] : null, match[0]); previous = "";
      }
      index += match[0].length;
    }
    if (plain) { out.push([null, plain]); }
    return out;
  }
  /** Appends highlighted code to an element using text nodes and spans only. */
  function highlightInto(element, code, language) {
    for (const [cls, value] of tokenize(code, language)) {
      if (!cls) { element.append(value); continue; }
      const span = element.ownerDocument.createElement("span"); span.className = cls; span.textContent = value; element.append(span);
    }
  }
  scope.stickHighlight = { tokenize, highlightInto, family };
})(typeof window === "undefined" ? globalThis : window);
