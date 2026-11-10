import { expect, it, vi } from "vitest";
import { GitHubClient, parseGitHubRepo, type GitHubRepo } from "../src/portable/github-client.js";
const sha = "a".repeat(40), other = "b".repeat(40), signal = () => new AbortController().signal;
const repo: GitHubRepo = { id: 1, owner: "owner", name: "repo", fullName: "owner/repo", defaultBranch: "main", private: false, canPush: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
it.each(["owner/repo", "https://github.com/owner/repo.git", "git@github.com:owner/repo.git"])("accepts a normal GitHub identity %s", (input) => { expect(parseGitHubRepo(input)).toEqual({ owner: "owner", name: "repo", fullName: "owner/repo" }); });
it.each(["https://github.com.evil.test/owner/repo", "https://token@github.com/owner/repo", "http://github.com/owner/repo", "https://github.com/owner/repo/../other", "owner/../repo", "https://example.com/owner/repo"])("rejects unsafe or unsupported repository input %s", (input) => { expect(() => parseGitHubRepo(input)).toThrow(); });
it("authenticates API requests and strips credentials from the archive redirect", async () => {
  const seen: { host: string; auth: string | null }[] = [];
  const client = new GitHubClient("private_token", (async (input, init) => {
    const url = new URL(String(input)); seen.push({ host: url.hostname, auth: new Headers(init?.headers).get("Authorization") });
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: "https://codeload.github.com/owner/repo/legacy.zip/" + sha } }) : new Response("archive bytes");
  }) as typeof fetch);
  expect((await client.archive(repo, sha, signal())).toString()).toBe("archive bytes");
  expect(seen).toEqual([{ host: "api.github.com", auth: "Bearer private_token" }, { host: "codeload.github.com", auth: null }]);
  expect(JSON.stringify(client)).not.toContain("private_token");
});
it("refuses an archive redirect to an unrelated host without requesting it", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }));
  await expect(new GitHubClient("private_token", fetcher as typeof fetch).archive(repo, sha, signal())).rejects.toThrow("unsupported download host"); expect(fetcher).toHaveBeenCalledOnce();
});
it("redacts even long tokens before truncating GitHub errors", async () => {
  const token = "z".repeat(600), client = new GitHubClient(token, (async () => json({ message: "validation: " + token }, 422)) as typeof fetch);
  try { await client.repository("owner/repo", signal()); throw new Error("expected failure"); }
  catch (error) { expect(String(error)).toContain("[redacted]"); expect(String(error)).not.toContain("z".repeat(20)); }
});
it("rejects oversized archives before buffering their bodies", async () => {
  const client = new GitHubClient("", (async () => new Response("small", { headers: { "content-length": String(65 * 1024 ** 2) } })) as typeof fetch);
  await expect(client.archive(repo, sha, signal())).rejects.toThrow("size limit");
});
it("cannot publish anonymously or update the default branch", async () => {
  const fetcher = vi.fn(async () => json({}));
  await expect(new GitHubClient("", fetcher as typeof fetch).blob(repo, Buffer.from("code"), signal())).rejects.toThrow("write and pull-request access");
  await expect(new GitHubClient("token", fetcher as typeof fetch).branch(repo, "main", sha, signal())).rejects.toThrow("new stick-ai/");
  expect(fetcher).not.toHaveBeenCalled();
});
it("creates only a new branch and a draft pull request with the selected base", async () => {
  const calls: { url: string; method?: string; body: any }[] = [];
  const client = new GitHubClient("token", (async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, method: init?.method, body });
    return url.endsWith("/git/refs") ? json({ ref: body.ref }, 201) : json({ html_url: "https://github.com/owner/repo/pull/42", number: 42 }, 201);
  }) as typeof fetch);
  await client.branch(repo, "stick-ai/new-work", sha, signal());
  expect(await client.pullRequest(repo, "stick-ai/new-work", "develop", "Reviewed changes", "Review this code", signal())).toEqual({ url: "https://github.com/owner/repo/pull/42", number: 42 });
  expect(calls[0]?.body).toEqual({ ref: "refs/heads/stick-ai/new-work", sha });
  expect(calls[1]?.body).toMatchObject({ head: "stick-ai/new-work", base: "develop", draft: true });
  expect(calls.every((call) => call.method === "POST")).toBe(true);
});
it("rejects unsafe paths before creating any changed tree", async () => {
  const fetcher = vi.fn(async () => json({ sha: other })); const client = new GitHubClient("token", fetcher as typeof fetch);
  await expect(client.createTree(repo, sha, [{ path: "../outside", mode: "100644", type: "blob", sha: other }], signal())).rejects.toThrow("Unsafe repository change");
  expect(fetcher).not.toHaveBeenCalled();
});
it('advances only its own unchanged branch without force and refuses external changes',async()=>{
  const calls:any[]=[];
  const client=new GitHubClient('token',(async(input,init)=>{calls.push({url:String(input),method:init?.method,body:init?.body?JSON.parse(String(init.body)):null});return json(init?.method==='GET'?{object:{sha}}:{ref:'refs/heads/stick-ai/task'});}) as typeof fetch);
  await client.advanceBranch(repo,'stick-ai/task',sha,other,signal());expect(calls[1].body).toEqual({sha:other,force:false});
  await expect(client.advanceBranch(repo,'stick-ai/task',other,sha,signal())).rejects.toThrow('branch changed');
  await expect(client.advanceBranch(repo,'main',sha,other,signal())).rejects.toThrow('workspace branch');expect(calls.filter(c=>c.method==='PATCH')).toHaveLength(1);
});
