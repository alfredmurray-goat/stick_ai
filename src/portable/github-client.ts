export interface GitHubRepo { id: number; owner: string; name: string; fullName: string; defaultBranch: string; private: boolean; canPush: boolean | null }
export interface GitHubBase { branch: string; commit: string; tree: string }
export interface GitHubTreeEntry { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number }
export class GitHubError extends Error { constructor(message: string, readonly status = 0) { super(message); this.name = "GitHubError"; } }
const hash = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function object(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) { throw new GitHubError("GitHub returned an unexpected response."); } return value as Record<string, any>; }
export function parseGitHubRepo(input: string): { owner: string; name: string; fullName: string } {
  if (typeof input !== "string" || input.length > 2048) { throw new GitHubError("Enter a GitHub repository URL or owner/repository."); }
  let value = input.trim().replace(/^git@github\.com:/i, "");
  if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$|[?#])/i.test(value)) { throw new GitHubError("Enter the repository URL without traversal segments."); }
  if (/^https?:/i.test(value)) {
    let url: URL; try { url = new URL(value); } catch { throw new GitHubError("Enter a valid GitHub repository URL."); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) { throw new GitHubError("Use an HTTPS github.com repository URL without credentials."); }
    try { value = decodeURIComponent(url.pathname.replace(/^\//, "")); } catch { throw new GitHubError("Enter a valid GitHub repository URL."); }
  }
  const parts = value.replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || [".", ".."].includes(name)) { throw new GitHubError("Enter a GitHub repository URL or owner/repository."); }
  return { owner, name, fullName: `${owner}/${name}` };
}
function pathFor(repo: Pick<GitHubRepo, "fullName">): string { const parsed = parseGitHubRepo(repo.fullName); return `/repos/${parsed.owner}/${parsed.name}`; }
function validBranch(value: string): boolean { return value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") && !value.includes("//") && !/[/.]$/.test(value) && !value.endsWith(".lock"); }
export class GitHubClient {
  #token: string;
  constructor(token = "", private readonly fetcher: typeof fetch = fetch) {
    this.#token = token.trim();
    if (this.#token && (!/^[\x21-\x7e]+$/.test(this.#token) || this.#token.length > 2048)) { throw new GitHubError("Enter a valid GitHub access token."); }
  }
  get authenticated(): boolean { return Boolean(this.#token); }
  async #response(method: string, path: string, body: unknown, signal: AbortSignal, archive = false): Promise<Response> {
    let url = new URL(path, "https://api.github.com");
    const allowed = archive ? ["api.github.com", "codeload.github.com"] : ["api.github.com"];
    if (method !== "GET" && !this.#token) { throw new GitHubError("Connect a GitHub token with repository write and pull-request access before publishing.", 401); }
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== "https:" || !allowed.includes(url.hostname) || url.port || url.username || url.password) { throw new GitHubError("GitHub redirected to an unsupported download host."); }
      let response: Response;
      try {
        response = await this.fetcher(url, { method, redirect: "manual", signal, headers: { Accept: archive ? "application/zip" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "stick-ai", ...(this.#token && url.hostname === "api.github.com" ? { Authorization: `Bearer ${this.#token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch { if (signal.aborted) { throw signal.reason; } throw new GitHubError("Could not reach GitHub. Check your connection and try again."); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location || method !== "GET") { throw new GitHubError("The repository moved. Reconnect it before publishing."); }
        url = new URL(location, url); continue;
      }
      if (response.ok) { return response; }
      let message = response.status === 401 ? "GitHub did not accept this token." : response.status === 403 ? "GitHub denied access. Check repository permissions or API limits." : response.status === 404 ? "GitHub could not find this repository or branch, or the token cannot access it." : "GitHub could not complete this request.";
      try { const detail = object(JSON.parse((await this.#bytes(response, 65536)).toString("utf8"))).message; if (typeof detail === "string" && ![401, 403, 404].includes(response.status)) { message += ` ${(this.#token ? detail.replaceAll(this.#token, "[redacted]") : detail).slice(0, 300)}`; } } catch {}
      if (this.#token) { message = message.replaceAll(this.#token, "[redacted]"); }
      throw new GitHubError(message, response.status);
    }
    throw new GitHubError("GitHub returned too many redirects.");
  }
  async #bytes(response: Response, limit: number, onBytes?: (bytes: number) => void): Promise<Buffer> {
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > limit) { await response.body?.cancel(); throw new GitHubError("This repository exceeds the current workspace size limit."); }
    if (!response.body) { throw new GitHubError("GitHub returned an empty response."); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) { break; }
        count += item.value.length; if (count > limit) { throw new GitHubError("This repository exceeds the current workspace size limit."); }
        chunks.push(item.value); onBytes?.(count);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks, count);
  }
  async #json(method: string, path: string, body: unknown, signal: AbortSignal): Promise<any> {
    const response = await this.#response(method, path, body, signal);
    try { return JSON.parse((await this.#bytes(response, 8 * 1024 ** 2)).toString("utf8")); }
    catch (error) { if (error instanceof GitHubError) { throw error; } throw new GitHubError("GitHub returned an unexpected response."); }
  }
  async repository(input: string, signal: AbortSignal): Promise<GitHubRepo> {
    const parsed = parseGitHubRepo(input), data = object(await this.#json("GET", pathFor(parsed), undefined, signal));
    const canonical = parseGitHubRepo(String(data.full_name ?? parsed.fullName));
    if (!Number.isSafeInteger(data.id) || data.id <= 0) { throw new GitHubError("GitHub returned an invalid repository identity."); }
    if (typeof data.default_branch !== "string" || !validBranch(data.default_branch)) { throw new GitHubError("This repository has no usable default branch."); }
    return { id: data.id, ...canonical, defaultBranch: data.default_branch, private: data.private === true, canPush: typeof data.permissions?.push === "boolean" ? data.permissions.push : null };
  }
  async branches(repo: GitHubRepo, signal: AbortSignal): Promise<string[]> {
    const data = await this.#json("GET", pathFor(repo) + "/branches?per_page=100", undefined, signal);
    if (!Array.isArray(data)) { throw new GitHubError("GitHub returned an unexpected branch list."); }
    return data.map((entry) => object(entry).name).filter((name): name is string => typeof name === "string" && validBranch(name));
  }
  async base(repo: GitHubRepo, branch: string, signal: AbortSignal): Promise<GitHubBase> {
    if (!validBranch(branch)) { throw new GitHubError("Choose a valid repository branch."); }
    const data = object(await this.#json("GET", pathFor(repo) + "/branches/" + encodeURIComponent(branch), undefined, signal));
    if (!hash(data.commit?.sha)) { throw new GitHubError("GitHub returned an invalid branch commit."); }
    const commit = object(await this.#json("GET", pathFor(repo) + "/git/commits/" + data.commit.sha, undefined, signal));
    if (!hash(commit.tree?.sha)) { throw new GitHubError("GitHub returned an invalid source tree."); }
    return { branch, commit: data.commit.sha, tree: commit.tree.sha };
  }
  async tree(repo: GitHubRepo, tree: string, signal: AbortSignal): Promise<GitHubTreeEntry[]> {
    if (!hash(tree)) { throw new GitHubError("Invalid repository tree."); }
    const data = object(await this.#json("GET", pathFor(repo) + `/git/trees/${tree}?recursive=1`, undefined, signal));
    if (data.truncated || !Array.isArray(data.tree) || data.tree.length > 30000) { throw new GitHubError("This repository is too large for the current workspace. Choose a smaller repository."); }
    return data.tree.map((entry: unknown) => {
      const value = object(entry);
      if (typeof value.path !== "string" || !["blob", "tree", "commit"].includes(value.type) || !hash(value.sha) || typeof value.mode !== "string") { throw new GitHubError("GitHub returned an invalid source entry."); }
      return value as unknown as GitHubTreeEntry;
    });
  }
  async archive(repo: GitHubRepo, commit: string, signal: AbortSignal, onBytes?: (bytes: number) => void): Promise<Buffer> {
    if (!hash(commit)) { throw new GitHubError("Invalid repository commit."); }
    return this.#bytes(await this.#response("GET", pathFor(repo) + "/zipball/" + commit, undefined, signal, true), 64 * 1024 ** 2, onBytes);
  }
  async blob(repo: GitHubRepo, bytes: Buffer, signal: AbortSignal): Promise<string> {
    if (bytes.length > 8 * 1024 ** 2) { throw new GitHubError("A changed file exceeds the 8 MB publishing limit."); }
    const data = object(await this.#json("POST", pathFor(repo) + "/git/blobs", { content: bytes.toString("base64"), encoding: "base64" }, signal));
    if (!hash(data.sha)) { throw new GitHubError("GitHub did not return a valid file hash."); } return data.sha;
  }
  async createTree(repo: GitHubRepo, base: string, entries: { path: string; mode: string; type: "blob"; sha: string | null }[], signal: AbortSignal): Promise<string> {
    if (!hash(base) || entries.some((entry) => !entry.path || entry.path.startsWith("/") || /[\\\x00]/.test(entry.path) || entry.path.split("/").some((part) => !part || [".", "..", ".git", ".stick"].includes(part.toLowerCase())) || !["100644", "100755"].includes(entry.mode) || entry.sha !== null && !hash(entry.sha))) { throw new GitHubError("Unsafe repository change."); }
    const data = object(await this.#json("POST", pathFor(repo) + "/git/trees", { base_tree: base, tree: entries }, signal));
    if (!hash(data.sha)) { throw new GitHubError("GitHub did not return a valid changed tree."); } return data.sha;
  }
  async commit(repo: GitHubRepo, tree: string, parent: string, message: string, signal: AbortSignal): Promise<string> {
    if (!hash(tree) || !hash(parent) || !message.trim() || message.length > 2000) { throw new GitHubError("Enter a short commit message."); }
    const data = object(await this.#json("POST", pathFor(repo) + "/git/commits", { message, tree, parents: [parent] }, signal));
    if (!hash(data.sha)) { throw new GitHubError("GitHub did not return a valid new commit."); } return data.sha;
  }
  async branch(repo: GitHubRepo, name: string, commit: string, signal: AbortSignal): Promise<void> {
    if (!name.startsWith("stick-ai/") || !validBranch(name) || !hash(commit)) { throw new GitHubError("Publishing requires a new stick-ai/ branch."); }
    await this.#json("POST", pathFor(repo) + "/git/refs", { ref: "refs/heads/" + name, sha: commit }, signal);
  }
  async advanceBranch(repo: GitHubRepo, name: string, expected: string, commit: string, signal: AbortSignal): Promise<void> {
    if (!name.startsWith("stick-ai/") || name === repo.defaultBranch || !validBranch(name) || !hash(expected) || !hash(commit)) { throw new GitHubError("Only the workspace branch can be updated."); }
    const path = pathFor(repo) + "/git/refs/heads/" + encodeURIComponent(name);
    const current = object(await this.#json("GET", path, undefined, signal));
    if (current.object?.sha !== expected) { throw new GitHubError("The pull-request branch changed on GitHub. Connect a fresh workspace to keep those changes."); }
    await this.#json("PATCH", path, { sha: commit, force: false }, signal);
  }
  async existingPullRequest(repo: GitHubRepo, head: string, base: string, signal: AbortSignal): Promise<{url:string;number:number}|undefined> {
    if (!head.startsWith("stick-ai/") || !validBranch(head) || !validBranch(base)) { throw new GitHubError("Invalid workspace branch."); }
    const data = await this.#json("GET", pathFor(repo) + "/pulls?state=all&head=" + encodeURIComponent(repo.owner + ":" + head) + "&base=" + encodeURIComponent(base) + "&per_page=100", undefined, signal);
    if (!Array.isArray(data)) { throw new GitHubError("GitHub returned an unexpected pull-request list."); }
    const item = data.find(value => value.head?.ref === head && value.head?.repo?.id === repo.id && value.base?.ref === base);
    if (!item) { return undefined; }
    if (item.state !== "open") { throw new GitHubError("This workspace pull request is closed. Connect a fresh workspace."); }
    if (!Number.isSafeInteger(item.number) || item.number <= 0 || item.html_url !== `https://github.com/${repo.fullName}/pull/${item.number}`) { throw new GitHubError("GitHub returned an invalid pull-request link."); }
    return {url:item.html_url,number:item.number};
  }
  async pullRequestOpen(repo: GitHubRepo, number: number, head: string, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(number) || number <= 0) { throw new GitHubError("Invalid pull-request identity."); }
    const data = object(await this.#json("GET", pathFor(repo) + "/pulls/" + number, undefined, signal));
    if (data.state !== "open" || data.head?.ref !== head || data.head?.repo?.id !== repo.id) { throw new GitHubError("The pull request is closed or its source changed. Connect a fresh workspace for another task."); }
  }
  async pullRequest(repo: GitHubRepo, head: string, base: string, title: string, body: string, signal: AbortSignal): Promise<{ url: string; number: number }> {
    if (!head.startsWith("stick-ai/") || !validBranch(head) || !validBranch(base) || !title.trim() || title.length > 256 || body.length > 16000) { throw new GitHubError("Enter a short pull-request title and description."); }
    const data = object(await this.#json("POST", pathFor(repo) + "/pulls", { head, base, title, body, draft: true }, signal));
    let url: URL; try { url = new URL(data.html_url); } catch { throw new GitHubError("GitHub did not return a valid pull-request link."); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || !Number.isSafeInteger(data.number) || data.number <= 0 || url.pathname.toLowerCase() !== `/${repo.fullName}/pull/${data.number}`.toLowerCase()) { throw new GitHubError("GitHub did not return a valid pull-request link."); }
    return { url: url.href, number: data.number };
  }
}
