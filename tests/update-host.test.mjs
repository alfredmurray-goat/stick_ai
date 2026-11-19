import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createUpdateHost, tokenCredentials } from "../scripts/update-host.mjs";

const account = "a".repeat(32);
const ok = (id) => new Response(JSON.stringify({ success: true, result: { id, status: "active" } }), { status: 200 });
const no = () => new Response(JSON.stringify({ success: false, errors: [{ message: "Invalid API Token" }] }), { status: 401 });

it("derives R2 keys from a Cloudflare API token: the token ID and the SHA-256 of the token", async () => {
  const fetcher = vi.fn(async () => ok("token-id"));
  expect(await tokenCredentials("secret-token", account, fetcher)).toEqual({ keyId: "token-id", secret: createHash("sha256").update("secret-token").digest("hex") });
  expect(fetcher.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer secret-token");
});

it("falls back to account-owned token verification and explains a rejected token", async () => {
  const fetcher = vi.fn(async (url) => String(url).includes("/accounts/") ? ok("account-token") : no());
  expect((await tokenCredentials("t", account, fetcher)).keyId).toBe("account-token");
  await expect(tokenCredentials("t", account, vi.fn(async () => no()))).rejects.toThrow(/R2 write access/);
});

it("is configured by the account, bucket and either an API token or R2 keys", () => {
  expect(createUpdateHost({})).toBeNull();
  expect(createUpdateHost({ R2_ACCOUNT_ID: account, R2_BUCKET: "stick-ai-updates" })).toBeNull();
  expect(createUpdateHost({ R2_ACCOUNT_ID: account, R2_BUCKET: "stick-ai-updates", CLOUDFLARE_API_TOKEN: "t" })).not.toBeNull();
  expect(createUpdateHost({ R2_ACCOUNT_ID: account, R2_BUCKET: "stick-ai-updates", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" })).not.toBeNull();
  expect(() => createUpdateHost({ R2_ACCOUNT_ID: "bad", R2_BUCKET: "stick-ai-updates", CLOUDFLARE_API_TOKEN: "t" })).toThrow(/not valid/);
});
