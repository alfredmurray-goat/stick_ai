import { expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";

// Stellan's own document readers (stellan-host --read-document) against the Node worker they replace
// (portable/input-worker.mjs, PDF.js for PDFs). Word files and every error must match exactly; PDF text must match
// at least 98% word for word (PDF.js sometimes splits letter-spaced words differently).
const host = process.env.STELLAN_TEST_HOST ?? resolve(`native-host-app/${process.platform === "win32" ? "Release/stellan-host.exe" : "stellan-host"}`);
const ready = existsSync(host);
if (process.env.STELLAN_REQUIRE_NATIVE_HOST === "1" && !ready) { throw new Error(`The native host is missing (${host})`); }

function node(bytes: Uint8Array, kind: "pdf" | "docx"): Promise<{ text?: string; error?: string }> {
  return new Promise((done) => { const worker = new Worker(resolve("portable/input-worker.mjs"), { workerData: { bytes, kind } }); worker.once("message", done); worker.once("error", (error) => done({ error: String(error) })); });
}
function native(bytes: Uint8Array, kind: "pdf" | "docx"): { text?: string; error?: string } {
  const result = spawnSync(host, ["--read-document", kind], { input: bytes, encoding: "utf8", timeout: 30000 });
  return JSON.parse(result.stdout);
}
const words = (text = "") => text.replace(/\[Page \d+\]/g, " ").split(/\s+/).filter(Boolean);
function similarity(a: string, b: string): number {
  const x = words(a), y = words(b); if (!x.length && !y.length) return 1;
  const previous = new Uint16Array(y.length + 1), current = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) { for (let j = 1; j <= y.length; j++) current[j] = x[i - 1] === y[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!); previous.set(current); }
  return (2 * previous[y.length]!) / (x.length + y.length);
}

const docx = (xml: string | Uint8Array, extra: Record<string, Uint8Array> = {}, level: 0 | 6 = 6) => zipSync({ "[Content_Types].xml": strToU8("<Types/>"), ...extra, "word/document.xml": [typeof xml === "string" ? strToU8(xml) : xml, { level }] });
const body = (inner: string) => `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${inner}</w:body></w:document>`;
const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

it.skipIf(!ready)("reads Word documents exactly as the Node reader, including every refusal", async () => {
  const cases: [string, Uint8Array][] = [
    ["plain", docx(body(paragraph("Hello world") + paragraph("Second line")))],
    ["stored", docx(body(paragraph("Stored, not compressed")), {}, 0)],
    ["entities and accents", docx(body(paragraph("Caf&#233; &amp; &lt;tags&gt; &#x1F988; &quot;q&quot; &apos;a&apos; Ærø &unknown;")))],
    ["tabs, breaks, tables, comments", docx(body(`<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p><!-- <w:t>hidden</w:t> --><w:tbl><w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:tabs/><w:t>no close`))],
    ["empty", docx(body("<w:p/>"))],
    ["doctype", docx(`<!DOCTYPE x>${body(paragraph("x"))}`)],
    ["bad character", docx(body(paragraph("&#xD800;")))],
    ["bad utf-8", docx(new Uint8Array([...strToU8(body(paragraph("a"))), 0xff]))],
    ["too much text", docx(body(paragraph("word ".repeat(6000))))],
    ["missing document", zipSync({ "other.xml": strToU8("<x/>") })],
    ["too many entries", zipSync(Object.fromEntries([...Array.from({ length: 1030 }, (_, i) => [`f${i}.txt`, strToU8("x")]), ["word/document.xml", strToU8(body(paragraph("late")))]]))]
  ];
  for (const [name, bytes] of cases) { expect(native(bytes, "docx"), name).toEqual(await node(bytes, "docx")); }
}, 60000);

// A small, valid PDF with a correct cross-reference table, so PDF.js and our reader both read it as written.
function pdf(pages: string[], options: { font?: string; encode?: (stream: string) => { data: string; filter: string }; encrypt?: boolean; extraObjects?: string[] } = {}): Uint8Array {
  const objects: string[] = [];
  const add = (text: string) => { objects.push(text); return objects.length; };
  const catalog = add(""); const tree = add("");
  const font = add(options.font ?? "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  for (const extra of options.extraObjects ?? []) { add(extra); }
  const kids: number[] = [];
  for (const content of pages) {
    const encoded = options.encode ? options.encode(content) : { data: content, filter: "" };
    const stream = add(`<< /Length ${Buffer.byteLength(encoded.data, "latin1")}${encoded.filter ? ` /Filter ${encoded.filter}` : ""} >>\nstream\n${encoded.data}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((text, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${text}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${options.encrypt ? " /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>" : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
const stream = (content: string) => `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
const text = (lines: string[]) => `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
function ascii85(bytes: Buffer): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = Buffer.alloc(4); bytes.copy(chunk, 0, i, Math.min(i + 4, bytes.length)); let value = chunk.readUInt32BE(0);
    const digits: string[] = []; for (let k = 0; k < 5; k++) { digits.unshift(String.fromCharCode(33 + (value % 85))); value = Math.floor(value / 85); }
    out += digits.slice(0, Math.min(5, bytes.length - i + 1)).join("");
  }
  return out + "~>";
}

it.skipIf(!ready)("reads PDFs like PDF.js and refuses the same PDFs with the same messages", async () => {
  const latin = (line: string) => Buffer.from(line, "latin1").toString("latin1");
  const cases: [string, Uint8Array][] = [
    ["plain", pdf([text(["Hello from Stellan", "Second line of text"])])],
    ["pages", pdf([text(["First page"]), text(["Second page"]), text(["Third page"])])],
    ["flate", pdf([text(["Compressed with Flate"])], { encode: (s) => ({ data: deflateSync(Buffer.from(s, "latin1")).toString("latin1"), filter: "/FlateDecode" }) })],
    ["ascii85 + flate", pdf([text(["Wrapped in ASCII85 then Flate"])], { encode: (s) => ({ data: ascii85(deflateSync(Buffer.from(s, "latin1"))), filter: "[/ASCII85Decode /FlateDecode]" }) })],
    ["ascii hex", pdf([text(["Hex encoded content"])], { encode: (s) => ({ data: Buffer.from(s, "latin1").toString("hex") + ">", filter: "/ASCIIHexDecode" }) })],
    ["win ansi accents", pdf([text([latin("Caf\xe9 na\xefve fa\xe7ade \xc6r\xf8 \x80 \x93 \x94")])])],
    ["kerned TJ", pdf(["BT /F1 12 Tf 72 720 Td [(Kern) -40 (ing) -600 (gap)] TJ ET"])],
    ["differences", pdf([text(["ABC"])], { font: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /eacute /germandbls /Euro] >> >>" })],
    ["to unicode", pdf(["BT /F1 12 Tf 72 720 Td <00010002> Tj ET"], { font: "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 4 0 R /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>] >>", extraObjects: [stream("begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <00C6> <0002> <D83EDD88> endbfchar endcmap")] })],
    ["image only page", pdf([text(["Text first"]), "q 1 0 0 1 0 0 cm Q"])],
    ["too many pages", pdf(Array.from({ length: 51 }, (_, i) => text([`Page ${i + 1}`])))],
    ["too much text", pdf(Array.from({ length: 40 }, () => text(Array.from({ length: 50 }, () => "lorem ipsum dolor sit amet consectetur"))))],
    ["encrypted", pdf([text(["Secret"])], { encrypt: true })],
    ["quick start guide", new Uint8Array(readFileSync("docs/packaging/quick-start-guide.pdf"))],
    ["first open card", new Uint8Array(readFileSync("docs/packaging/first-open-card.pdf"))]
  ];
  for (const [name, bytes] of cases) {
    const expected = await node(bytes, "pdf"), actual = native(bytes, "pdf");
    // PDF.js may open some encrypted files; Stellan's reader asks for an unlocked copy instead (docs/HOST_WINDOW_SERVER.md).
    if (name === "encrypted") { expect(actual, name).toEqual({ error: "Unlock the password-protected PDF before attaching it." }); continue; }
    if (expected.error !== undefined) { expect(actual, name).toEqual(expected); continue; }
    expect(actual.error, name).toBeUndefined();
    expect(similarity(expected.text!, actual.text!), name).toBeGreaterThanOrEqual(0.98);
  }
}, 120000);
