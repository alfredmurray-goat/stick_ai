import { expect, it } from "vitest";
import { compactWebResult } from "../src/portable/web-search.js";

const search = { tier: "free", query: "running shoes", results: [{ domain: "altrarunning.com", name: "Altra Running", actions: [{ id: "shop", name: "Shop", description: "x".repeat(2000) }], snippet: "Zero-drop running shoes.", visit_url: "https://api.actuent.ai/go?u=x" }], products: [{ name: "Trail shoe", price: 1207, currency: "INR", domain: "redtape.com", url: "https://redtape.com/p/1" }], message: "Showing 1 of 44." };

it("keeps names, links, snippets and prices from a search and drops the rest", () => {
  const raw = JSON.stringify(search);
  const small = compactWebResult("search", raw + "\n" + JSON.stringify({ extra: true }));
  expect(small).toContain("Altra Running · https://altrarunning.com");
  expect(small).toContain("Zero-drop running shoes.");
  expect(small).toContain("Trail shoe · 1207 INR · redtape.com · https://redtape.com/p/1");
  expect(small).toContain("Note: Showing 1 of 44.");
  expect(small).not.toContain("xxxx");
  expect(small.length).toBeLessThan(raw.length / 5);
});

it("keeps a page's title, text and main links within the limit", () => {
  const page = { url: "https://react.dev/blog", readable: true, title: "React Blog", text: "React 19.3 adds things. ".repeat(1000), text_truncated: true, links: [{ text: "Docs", url: "https://react.dev/learn" }] };
  const small = compactWebResult("page", JSON.stringify(page), 3000);
  expect(small.startsWith("React Blog · https://react.dev/blog\n")).toBe(true);
  expect(small).toContain("React 19.3 adds things.");
  expect(small.length).toBeLessThanOrEqual(3000 + 4);
  expect(compactWebResult("page", JSON.stringify({ url: "https://x.test", readable: false, reason: "HTTP 404" }))).toBe("Could not read https://x.test: HTTP 404");
});

it("passes plain text and errors through, and says when nothing was found", () => {
  expect(compactWebResult("search", "Denied by user")).toBe("Denied by user");
  expect(compactWebResult("search", "Error: " + JSON.stringify({ error: "Actuent is busy" }))).toBe("Error: Note: Actuent is busy");
  expect(compactWebResult("search", JSON.stringify({ results: [] }))).toMatch(/^No results/);
});
