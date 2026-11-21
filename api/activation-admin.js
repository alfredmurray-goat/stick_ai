// The owner's activation desk, used from /admin (a plain form: the site runs no scripts). Protected by the
// ACTIVATION_ADMIN_TOKEN environment variable set in Vercel. Actions:
//   setup     creates the signing key once (kept in the database) and shows the public key for the app
//   generate  makes new codes to print, shown as a list
//   lookup    shows a code's status
//   reset     frees a code so an honest customer can activate a replacement stick
import { generateKeyPairSync, timingSafeEqual, createPrivateKey, createPublicKey } from "node:crypto";
import { newCode, normaliseCode, pretty, redis, storage } from "./_activation.js";

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function page(res, status, title, body) {
  res.statusCode = status; res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", "noindex");
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · stick_ai admin</title><link rel="stylesheet" href="/style.css"></head><body><main class="page"><a class="back" href="/admin">← activation desk</a><h1>${escape(title)}</h1>${body}</main></body></html>`);
}
function allowed(given) {
  const expected = process.env.ACTIVATION_ADMIN_TOKEN || "";
  if (expected.length < 20 || typeof given !== "string") { return false; }
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.statusCode = 303; res.setHeader("Location", "/admin"); res.end(); return; }
  const form = typeof req.body === "object" && req.body ? req.body : Object.fromEntries(new URLSearchParams(String(req.body ?? "")));
  if (!(process.env.ACTIVATION_ADMIN_TOKEN || "").length) { page(res, 503, "Not set up", "<p>Add an <b>ACTIVATION_ADMIN_TOKEN</b> environment variable in Vercel (at least 20 characters), then redeploy.</p>"); return; }
  if (!allowed(form.token)) { await new Promise((resolve) => setTimeout(resolve, 1500)); page(res, 403, "Wrong password", "<p>That admin password isn't right.</p>"); return; }
  const db = storage();
  if (!db) { page(res, 503, "No database", "<p>Connect Upstash under Storage in Vercel (the same one the sign-up form uses).</p>"); return; }
  try {
    if (form.action === "setup") {
      let pem = await redis(db, "GET", "activation:signing-key");
      if (!pem) {
        pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
        await redis(db, "SET", "activation:signing-key", pem, "NX");
        pem = await redis(db, "GET", "activation:signing-key");
      }
      const publicKey = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }).toString("base64");
      page(res, 200, "Activation is set up", `<p>The app checks certificates with this <b>public</b> key. It's safe to share: send it to whoever builds the app.</p><pre class="tree">${escape(publicKey)}</pre>`);
      return;
    }
    if (form.action === "generate") {
      const count = Math.min(Math.max(Number.parseInt(form.count, 10) || 0, 1), 500);
      const codes = [];
      while (codes.length < count) {
        const code = newCode();
        if (await redis(db, "HSETNX", `activation:code:${code}`, "createdAt", new Date().toISOString())) { codes.push(code); await redis(db, "SADD", "activation:codes", code); }
      }
      page(res, 200, `${count} new codes`, `<p>Print one code per box. Each code activates one stick. They're saved, so you can close this page.</p><pre class="tree">${codes.map(pretty).join("\n")}</pre>`);
      return;
    }
    const code = normaliseCode(form.code);
    if (!code) { page(res, 400, "Check the code", "<p>Enter a 12-character code, like ABCD-EFGH-JKMN.</p>"); return; }
    const key = `activation:code:${code}`;
    if (!(await redis(db, "EXISTS", key))) { page(res, 404, "Unknown code", `<p>${escape(pretty(code))} was never generated.</p>`); return; }
    if (form.action === "reset") {
      await redis(db, "HDEL", key, "sticks", "activatedAt", "lastAt");
      page(res, 200, "Code reset", `<p>${escape(pretty(code))} can now activate a new stick.</p>`); return;
    }
    const [sticks, activatedAt, lastAt] = await redis(db, "HMGET", key, "sticks", "activatedAt", "lastAt");
    const used = sticks ? JSON.parse(sticks).length : 0;
    page(res, 200, pretty(code), `<p>${used ? `Activated on ${used} stick view${used === 1 ? "" : "s"} (of 3), first on ${escape(activatedAt ?? "?")}, last on ${escape(lastAt ?? "?")}.` : "Not activated yet."}</p>`);
  } catch {
    page(res, 503, "Busy", "<p>The database didn't answer. Try again in a minute.</p>");
  }
}
