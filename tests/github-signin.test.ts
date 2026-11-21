import { expect, it, vi } from "vitest";
import { GitHubSignIn, githubAppClientId, githubAppInstallUrl } from "../src/portable/github-auth.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const instant = async () => {};

function fakeGitHub(replies: unknown[]) {
  const calls: { url: string; body: string; auth: string }[] = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input); const headers = new Headers(init?.headers);
    calls.push({ url, body: String(init?.body ?? ""), auth: headers.get("authorization") ?? "" });
    if (url.endsWith("/login/device/code")) return json({ device_code: "device-123", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    if (url.endsWith("/login/oauth/access_token")) return json(replies.shift());
    if (url === "https://api.github.com/user") return json({ login: "octocat" });
    return json({ message: "unexpected" }, 404);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

it("signs in with a device code: waits, slows down when asked, then keeps the token out of every view", async () => {
  const { fetcher, calls } = fakeGitHub([{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: "ghu_secretToken1234567890", expires_in: 28800, refresh_token: "ghr_x" }]);
  const waits: number[] = [];
  const signIn = new GitHubSignIn(fetcher, githubAppClientId, async (ms) => { waits.push(ms); });
  const started = await signIn.start();
  expect(started).toMatchObject({ status: "waiting", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", installUrl: githubAppInstallUrl });
  expect(calls[0]!.body).toBe(`client_id=${githubAppClientId}`);
  await until(() => signIn.view().status === "signed-in" && Boolean(signIn.view().login));
  expect(signIn.view()).toMatchObject({ status: "signed-in", login: "octocat" });
  expect(signIn.token()).toBe("ghu_secretToken1234567890");
  expect(JSON.stringify(signIn.view())).not.toContain("ghu_");
  expect(waits).toEqual([5000, 5000, 10000]);
  expect(calls.filter((call) => call.url.endsWith("/access_token")).every((call) => call.body.includes("device_code=device-123") && call.body.includes("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code") && !call.body.includes("secret"))).toBe(true);
  expect(calls.find((call) => call.url === "https://api.github.com/user")!.auth).toBe("Bearer ghu_secretToken1234567890");
  signIn.signOut(); expect(signIn.token()).toBe(""); expect(signIn.view().status).toBe("signed-out");
});

it("reports a cancelled or expired sign-in plainly and forgets everything", async () => {
  const denied = new GitHubSignIn(fakeGitHub([{ error: "access_denied" }]).fetcher, githubAppClientId, instant);
  await denied.start(); await until(() => denied.view().status !== "waiting");
  expect(denied.view()).toMatchObject({ status: "denied", message: expect.stringContaining("cancelled") }); expect(denied.token()).toBe("");
  const expired = new GitHubSignIn(fakeGitHub([{ error: "expired_token" }]).fetcher, githubAppClientId, instant);
  await expired.start(); await until(() => expired.view().status !== "waiting");
  expect(expired.view()).toMatchObject({ status: "expired", message: expect.stringContaining("new one") });
});

it("lets the user cancel while waiting, and ends a sign-in after GitHub's 8 hours", async () => {
  let release!: () => void;
  const signIn = new GitHubSignIn(fakeGitHub([{ access_token: "ghu_late1234567890", expires_in: 28800 }]).fetcher, githubAppClientId, (_ms, signal) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }));
  await signIn.start(); signIn.cancel(); release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(signIn.view().status).toBe("signed-out"); expect(signIn.token()).toBe("");

  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const timed = new GitHubSignIn(fakeGitHub([{ access_token: "ghu_timed1234567890", expires_in: 28800 }]).fetcher, githubAppClientId, instant);
    await timed.start(); await until(() => timed.view().status === "signed-in");
    expect(timed.token()).toBe("ghu_timed1234567890");
    vi.setSystemTime(Date.now() + 8 * 3600 * 1000);
    expect(timed.view()).toMatchObject({ status: "expired", message: expect.stringContaining("8 hours") }); expect(timed.token()).toBe("");
  } finally { vi.useRealTimers(); }
});

it("explains when device sign-in is switched off for the app", async () => {
  const fetcher = (async () => json({ error: "device_flow_disabled" }, 400)) as unknown as typeof fetch;
  await expect(new GitHubSignIn(fetcher, githubAppClientId, instant).start()).rejects.toThrow(/Enable Device Flow/);
});
