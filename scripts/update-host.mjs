// Uploads signed app updates to the private update host (Cloudflare R2) that sold sticks check.
// Every build goes in its own folder (<prefix>/<run>/...) and the feed is written last, so a stick
// never sees a feed that points at files that aren't there yet.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

export const defaultFeedUrl = "https://updates.localilabs.com/stick-ai/stick_ai-updates.json";
const run = promisify(execFile);

/**
 * S3 credentials from a Cloudflare API token with R2 write access, as Cloudflare documents: the access key ID is
 * the token's ID and the secret is the SHA-256 of the token. One GitHub secret then covers uploads.
 */
export async function tokenCredentials(token, account, fetcher = fetch) {
  for (const path of ["user/tokens/verify", `accounts/${account}/tokens/verify`]) {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.success && typeof body.result?.id === "string" && body.result.status === "active") {
      return { keyId: body.result.id, secret: createHash("sha256").update(token).digest("hex") };
    }
  }
  throw new Error("CLOUDFLARE_API_TOKEN was not accepted by Cloudflare. Check it is active and has R2 write access.");
}

/** Returns an uploader when the R2 settings are present, otherwise null (publishing then skips the host). */
export function createUpdateHost(env = process.env, fetcher = fetch) {
  const { R2_ACCOUNT_ID: account, R2_BUCKET: bucket, R2_ACCESS_KEY_ID: keyId, R2_SECRET_ACCESS_KEY: secret, CLOUDFLARE_API_TOKEN: token } = env;
  if (!account || !bucket || !((keyId && secret) || token)) { return null; }
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) { throw new Error("R2_ACCOUNT_ID or R2_BUCKET is not valid"); }
  let credentials;
  const awsEnv = async () => {
    credentials ??= keyId && secret ? Promise.resolve({ keyId, secret }) : tokenCredentials(token, account, fetcher);
    const resolved = await credentials;
    return {
      ...env, AWS_ACCESS_KEY_ID: resolved.keyId, AWS_SECRET_ACCESS_KEY: resolved.secret, AWS_DEFAULT_REGION: "auto",
      // R2 rejects some of the newer default request checksums; only send them when required.
      AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED", AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED"
    };
  };
  return {
    async put(file, key, { contentType, cacheControl }) {
      await run("aws", ["s3", "cp", file, `s3://${bucket}/${key}`, "--endpoint-url", `https://${account}.r2.cloudflarestorage.com`, "--content-type", contentType, "--cache-control", cacheControl, "--only-show-errors"], { env: await awsEnv(), maxBuffer: 10 * 1024 * 1024 });
    }
  };
}

/** The path of the feed inside the bucket, taken from the public feed URL the app is built with. */
export function feedKey(feedUrl = defaultFeedUrl) {
  const url = new URL(feedUrl);
  if (url.protocol !== "https:" || !url.pathname.endsWith("/stick_ai-updates.json")) { throw new Error("The update feed URL must be https and end with /stick_ai-updates.json"); }
  return url.pathname.slice(1);
}

/** Sequence of the feed sticks currently see, or 0 when there is none or it can't be read. */
export async function publishedSequence(feedUrl = defaultFeedUrl, fetcher = fetch) {
  try {
    const response = await fetcher(feedUrl, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); return 0; }
    const envelope = await response.json();
    const sequence = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")).sequence;
    return Number.isSafeInteger(sequence) ? sequence : 0;
  } catch { return 0; }
}
