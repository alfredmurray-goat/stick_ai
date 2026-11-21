// Shared by the activation endpoints. Files starting with "_" are not deployed as their own functions.
import { randomInt } from "node:crypto";

// Crockford base32: no I, L, O or U, so codes are easy to read aloud and type from a printed card.
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function storage() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export async function redis(db, ...command) {
  const response = await fetch(db.url, { method: "POST", headers: { Authorization: `Bearer ${db.token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  if (!response.ok) { throw new Error(`Upstash answered ${response.status}`); }
  return (await response.json()).result;
}

/** "abcd-efgh-jkmn", "ABCDEFGHJKMN" and look-alikes (O→0, I/L→1) all become "ABCDEFGHJKMN"; anything else is "". */
export function normaliseCode(value) {
  if (typeof value !== "string" || value.length > 40) { return ""; }
  const code = value.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return code.length === 12 && [...code].every((c) => ALPHABET.includes(c)) ? code : "";
}

export function newCode() { let code = ""; for (let i = 0; i < 12; i++) { code += ALPHABET[randomInt(ALPHABET.length)]; } return code; }
export const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
