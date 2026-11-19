// Actuent answers with rich JSON (actions, ranks, freshness notes) sized for big cloud models. Lite reads prompts
// at a few dozen tokens a second on a laptop CPU, so a 30 KB result would cost minutes. Keep only what answers
// the question: names, links, snippets, prices, dates and page text.
type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, limit: number): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
const list = (value: unknown): Json[] => Array.isArray(value) ? value.filter(isRecord) : [];
const line = (...parts: string[]): string => parts.filter(Boolean).join(" · ");

export function compactWebResult(kind: "search" | "page", raw: string, limit = 6000): string {
  const error = raw.startsWith("Error: ");
  // mcp.call returns the text content and, after a newline, any structured content: either half may be the JSON.
  const body = error ? raw.slice(7) : raw, split = body.indexOf("\n{");
  let value: unknown;
  for (const candidate of [body, split > 0 ? body.slice(0, split) : "", split > 0 ? body.slice(split + 1) : ""]) {
    if (!candidate) { continue; }
    try { value = JSON.parse(candidate); break; } catch { /* try the next part */ }
  }
  if (value === undefined) { return raw.slice(0, limit); }
  if (!isRecord(value)) { return raw.slice(0, limit); }
  const out: string[] = [];
  const message = text(value.message, 400) || text(value.error, 400);
  if (message) { out.push(`Note: ${message}`); }
  if (kind === "page") {
    if (value.readable === false) { out.push(`Could not read ${text(value.url, 300)}: ${text(value.reason, 300)}`); }
    else {
      out.push(line(text(value.title, 200), text(value.url, 300)));
      if (value.description) { out.push(text(value.description, 400)); }
      const body = text(value.text, Math.max(500, limit - 1500));
      if (body) { out.push(body + (value.text_truncated ? " […]" : "")); }
      const links = list(value.links).slice(0, 12).map((link) => `- ${text(link.text, 80)}: ${text(link.url, 300)}`);
      if (links.length) { out.push("Links:", ...links); }
    }
  } else {
    const answer = isRecord(value.answer) ? text(value.answer.text ?? value.answer.summary, 800) : text(value.answer, 800);
    if (answer) { out.push(`Answer: ${answer}`); }
    for (const result of list(value.results).slice(0, 6)) {
      const where = text(result.url, 300) || (result.domain ? `https://${text(result.domain, 200)}` : "");
      out.push(`- ${line(text(result.name, 120) || text(result.domain, 120), where)}${result.snippet ? `\n  ${text(result.snippet, 300)}` : ""}`);
    }
    for (const product of list(value.products).slice(0, 5)) {
      const price = product.price === undefined ? "" : `${String(product.price)} ${text(product.currency, 8)}`.trim();
      out.push(`- ${line(text(product.name, 120), price, text(product.domain, 80), text(product.url, 300))}`);
    }
    for (const event of list(value.events).slice(0, 5)) {
      out.push(`- ${line(text(event.name ?? event.title, 120), text(event.start ?? event.date, 40), text(isRecord(event.venue) ? event.venue.name : event.venue, 80), text(event.url ?? event.visit_url, 300))}`);
    }
    if (!error && out.length === (message ? 1 : 0)) { out.push("No results. Try different words, or read a specific page with read_web_page."); }
  }
  const result = out.join("\n");
  return (error ? "Error: " : "") + (result.length > limit ? result.slice(0, limit) + " […]" : result);
}
