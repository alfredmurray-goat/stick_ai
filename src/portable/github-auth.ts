import { appFetch } from "./net.js";
// "Sign in with GitHub" through GitHub's device flow, for the Stick AI GitHub App. The app shows a short
// code, the user enters it at github.com/login/device, and GitHub hands this app a user token. No client
// secret or private key is involved (the client ID is public by design), and nothing passes through a
// server of ours. The token lives only in this process's memory: it is never saved, logged, sent to the
// window or given to the model. A GitHub App token only reaches repositories where the user installed
// the app, so people choose exactly which repositories Stick AI can touch.
import { GitHubError } from "./github-client.js";

export const githubAppClientId = "Iv23liQrxXoJNF45IQdv";
/** Where people choose which repositories the app may use. */
export const githubAppInstallUrl = "https://github.com/apps/stick-ai/installations/new";
export const githubDeviceUrl = "https://github.com/login/device";

export type SignInStatus = "signed-out" | "waiting" | "signed-in" | "expired" | "denied" | "failed";
export interface SignInView { status: SignInStatus; userCode?: string; verificationUri?: string; login?: string; message?: string; installUrl: string }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

export class GitHubSignIn {
  #token = ""; #expires = 0; #login = ""; #status: SignInStatus = "signed-out"; #message = "";
  #userCode = ""; #verificationUri = ""; #polling: AbortController | undefined;
  constructor(private readonly fetcher: typeof fetch = appFetch, private readonly clientId = githubAppClientId, private readonly wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); })) {}

  view(): SignInView {
    if (this.#status === "signed-in" && this.#expires && Date.now() >= this.#expires) { this.#forget("expired", "Your GitHub sign-in ended after 8 hours. Sign in again to keep publishing."); }
    return { status: this.#status, installUrl: githubAppInstallUrl, ...(this.#status === "waiting" ? { userCode: this.#userCode, verificationUri: this.#verificationUri } : {}), ...(this.#login && this.#status === "signed-in" ? { login: this.#login } : {}), ...(this.#message ? { message: this.#message } : {}) };
  }
  /** The signed-in user's token, or "" when not signed in (callers then fall back to a pasted token or public access). */
  token(): string { return this.view().status === "signed-in" ? this.#token : ""; }

  async #post(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.fetcher(url, { method: "POST", redirect: "error", signal, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "stick-ai" }, body: new URLSearchParams(fields).toString() }); }
    catch { if (signal.aborted) { throw signal.reason; } throw new GitHubError("Could not reach GitHub. Check your internet connection and try again."); }
    const text = await response.text();
    let value: Record<string, unknown>; try { value = record(JSON.parse(text)); } catch { throw new GitHubError("GitHub sent an unexpected reply. Try signing in again."); }
    if (!response.ok && !value.error) { throw new GitHubError(`GitHub sign-in failed (HTTP ${response.status}). Try again in a minute.`); }
    return value;
  }

  /** Starts a sign-in and returns the code to show; GitHub is then polled in the background until it finishes. */
  async start(): Promise<SignInView> {
    this.cancel();
    const controller = new AbortController(); this.#polling = controller;
    const device = await this.#post("https://github.com/login/device/code", { client_id: this.clientId }, controller.signal);
    if (typeof device.error === "string") { throw new GitHubError(device.error === "device_flow_disabled" ? "Device sign-in is switched off for the Stick AI GitHub App. Turn on Enable Device Flow in its settings." : "GitHub refused to start a sign-in. Try again in a minute."); }
    const deviceCode = device.device_code, userCode = device.user_code, uri = device.verification_uri;
    if (typeof deviceCode !== "string" || typeof userCode !== "string" || !/^[A-Z0-9-]{4,20}$/.test(userCode) || typeof uri !== "string" || !uri.startsWith("https://github.com/")) { throw new GitHubError("GitHub sent an unexpected reply. Try signing in again."); }
    const expiresIn = Math.min(Number(device.expires_in) || 900, 1800), interval = Math.max(Number(device.interval) || 5, 1);
    // Clear any earlier sign-in first, then keep this one's poller (forgetting aborts the current poller).
    this.#polling = undefined; this.#forget("waiting", ""); this.#polling = controller; this.#userCode = userCode; this.#verificationUri = uri;
    void this.#poll(deviceCode, interval, Date.now() + expiresIn * 1000, controller).catch(() => undefined);
    return this.view();
  }

  async #poll(deviceCode: string, interval: number, deadline: number, controller: AbortController): Promise<void> {
    let every = interval;
    while (Date.now() < deadline) {
      await this.wait(every * 1000, controller.signal);
      let reply: Record<string, unknown>;
      try { reply = await this.#post("https://github.com/login/oauth/access_token", { client_id: this.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, controller.signal); }
      catch { if (controller.signal.aborted) { return; } every += 5; continue; }
      if (this.#polling !== controller) { return; }
      if (typeof reply.access_token === "string" && /^[\x21-\x7e]{10,2048}$/.test(reply.access_token)) {
        this.#token = reply.access_token; this.#expires = Number(reply.expires_in) > 0 ? Date.now() + Number(reply.expires_in) * 1000 - 60000 : 0;
        this.#status = "signed-in"; this.#message = ""; this.#userCode = ""; this.#polling = undefined;
        this.#login = await this.#who(controller.signal).catch(() => "");
        return;
      }
      if (reply.error === "authorization_pending") { continue; }
      if (reply.error === "slow_down") { every = Math.max(Number(reply.interval) || every + 5, every + 5); continue; }
      if (reply.error === "access_denied") { this.#forget("denied", "Sign-in was cancelled on GitHub. Click Sign in with GitHub to try again."); return; }
      this.#forget(reply.error === "expired_token" ? "expired" : "failed", reply.error === "expired_token" ? "The sign-in code expired. Click Sign in with GitHub for a new one." : "GitHub sign-in failed. Try again."); return;
    }
    if (this.#polling === controller) { this.#forget("expired", "The sign-in code expired. Click Sign in with GitHub for a new one."); }
  }

  async #who(signal: AbortSignal): Promise<string> {
    const response = await this.fetcher("https://api.github.com/user", { redirect: "error", signal, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "stick-ai", Authorization: `Bearer ${this.#token}` } });
    const login = record(await response.json()).login;
    return typeof login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : "";
  }

  #forget(status: SignInStatus, message: string): void {
    this.#polling?.abort(); this.#polling = undefined;
    this.#token = ""; this.#expires = 0; this.#login = ""; this.#userCode = ""; this.#verificationUri = "";
    this.#status = status; this.#message = message;
  }
  cancel(): void { if (this.#status === "waiting") { this.#forget("signed-out", ""); } else { this.#polling?.abort(); this.#polling = undefined; } }
  signOut(): void { this.#forget("signed-out", ""); }
}
