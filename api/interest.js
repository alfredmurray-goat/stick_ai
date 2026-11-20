// "Tell me when it launches": stores an email, its region and when it was given, nothing else.
// Storage is Upstash Redis, added to the Vercel project from Storage → Upstash (it sets the two env vars below).
// The site has no JavaScript, so the form posts here and the reply is a redirect to a plain page.
const regions = new Set(["eu", "world"]);
const consentVersion = "2026-11-20";

function storage() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(db, ...command) {
  const response = await fetch(db.url, { method: "POST", headers: { Authorization: `Bearer ${db.token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  if (!response.ok) { throw new Error(`Upstash answered ${response.status}`); }
  return (await response.json()).result;
}

export function validEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(value);
}

function back(res, page) { res.statusCode = 303; res.setHeader("Location", page); res.setHeader("Cache-Control", "no-store"); res.end(); }

export default async function handler(req, res) {
  if (req.method !== "POST") { res.statusCode = 405; res.setHeader("Allow", "POST"); res.end("Use the form on the home page."); return; }
  const form = typeof req.body === "object" && req.body ? req.body : Object.fromEntries(new URLSearchParams(String(req.body ?? "")));
  // A field people can't see: bots fill it in, people don't. Pretend it worked.
  if (form.website) { back(res, "/thanks"); return; }
  const email = String(form.email ?? "").trim().toLowerCase();
  const region = String(form.region ?? "");
  if (!validEmail(email) || !regions.has(region)) { back(res, "/signup-problem?reason=details"); return; }
  if (form.consent !== "yes") { back(res, "/signup-problem?reason=consent"); return; }
  const db = storage();
  if (!db) { back(res, "/signup-problem?reason=closed"); return; }
  try {
    await redis(db, "HSET", "interest", email, JSON.stringify({ region, at: new Date().toISOString(), consent: consentVersion }));
    back(res, "/thanks");
  } catch {
    back(res, "/signup-problem?reason=busy");
  }
}
