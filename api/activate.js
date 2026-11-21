// One-time activation for Stick AI. The app sends the code printed in the box and a fingerprint of the
// stick (a SHA-256 of its USB serial number, or of its volume ID when the serial can't be read). The first
// time, the code is tied to that stick; afterwards the same stick can activate again (for example after a
// reinstall), while other sticks are refused. Each code has a few "seats" because one stick can look
// different to different computers when its serial can't be read. The reply is a certificate signed with an
// Ed25519 key kept in the database; the app checks it offline at every start with the public key it ships.
import { createPrivateKey, sign } from "node:crypto";
import { normaliseCode, redis, storage } from "./_activation.js";

const SEATS = 3;
const json = (res, status, value) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(value)); };

export default async function handler(req, res) {
  if (req.method !== "POST") { json(res, 405, { error: "Use the Stick AI app to activate." }); return; }
  const body = typeof req.body === "object" && req.body ? req.body : (() => { try { return JSON.parse(String(req.body ?? "")); } catch { return {}; } })();
  const code = normaliseCode(body.code);
  const stick = typeof body.stick === "string" && /^[a-f0-9]{64}$/.test(body.stick) ? body.stick : "";
  if (!code || !stick) { json(res, 400, { error: "That doesn't look like an activation code. It has 12 letters and numbers, like ABCD-EFGH-JKMN." }); return; }
  const db = storage();
  if (!db) { json(res, 503, { error: "Activation is not available right now. Try again in a few minutes." }); return; }
  try {
    const pem = await redis(db, "GET", "activation:signing-key");
    if (!pem) { json(res, 503, { error: "Activation is not set up yet. Try again later." }); return; }
    const key = `activation:code:${code}`;
    const record = await redis(db, "HGETALL", key);
    if (!Array.isArray(record) || !record.length) { json(res, 404, { error: "This code isn't valid. Check it against the guide in the box (the letters O and I are never used)." }); return; }
    const fields = Object.fromEntries(record.reduce((pairs, value, index) => (index % 2 ? pairs[pairs.length - 1].push(value) : pairs.push([value]), pairs), []));
    const sticks = fields.sticks ? JSON.parse(fields.sticks) : [];
    if (!sticks.includes(stick)) {
      if (sticks.length >= SEATS) { json(res, 409, { error: "This code is already in use on another stick. If this is your stick, contact us through stick-ai.localilabs.com/start and we'll move it." }); return; }
      sticks.push(stick);
      await redis(db, "HSET", key, "sticks", JSON.stringify(sticks), "activatedAt", fields.activatedAt || new Date().toISOString(), "lastAt", new Date().toISOString());
    }
    const payload = Buffer.from(JSON.stringify({ v: 1, code, stick, at: new Date().toISOString() })).toString("base64url");
    const signature = sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url");
    json(res, 200, { certificate: `${payload}.${signature}` });
  } catch {
    json(res, 503, { error: "Activation is busy. Try again in a minute." });
  }
}
