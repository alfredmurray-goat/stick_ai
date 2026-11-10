import { expect, it, vi } from "vitest";
import { successfulDesktopBuild } from "../scripts/release-build.mjs";
const repo = "owner/repo";
const trusted = { head_branch: "main", path: ".github/workflows/desktop.yml", head_repository: { full_name: repo }, event: "workflow_dispatch", status: "completed", conclusion: "success" };
it("waits for the final dispatch job to close before trusting a successful build", async () => {
  const gh = vi.fn().mockResolvedValueOnce(JSON.stringify({ ...trusted, status: "in_progress", conclusion: null })).mockResolvedValueOnce(JSON.stringify(trusted));
  const wait = vi.fn();
  expect(await successfulDesktopBuild(repo, "123", gh, wait)).toEqual(trusted);
  expect(wait).toHaveBeenCalledOnce();
});
it.each(["failure", "cancelled", "timed_out"])("rejects a completed %s build without waiting", async (conclusion) => {
  const wait = vi.fn();
  await expect(successfulDesktopBuild(repo, "123", async () => JSON.stringify({ ...trusted, conclusion }), wait)).rejects.toThrow("Only successful");
  expect(wait).not.toHaveBeenCalled();
});
it.each([{ head_branch: "other" }, { path: ".github/workflows/other.yml" }, { head_repository: { full_name: "fork/repo" } }, { event: "pull_request" }])("rejects untrusted provenance before polling", async (change) => {
  const wait = vi.fn();
  await expect(successfulDesktopBuild(repo, "123", async () => JSON.stringify({ ...trusted, ...change, status: "in_progress", conclusion: null }), wait)).rejects.toThrow("Only successful");
  expect(wait).not.toHaveBeenCalled();
});
it("bounds waiting and never treats an unfinished build as successful", async () => {
  const wait = vi.fn(), gh = vi.fn(async () => JSON.stringify({ ...trusted, status: "in_progress", conclusion: null }));
  await expect(successfulDesktopBuild(repo, "123", gh, wait, 2)).rejects.toThrow("has not completed");
  expect(gh).toHaveBeenCalledTimes(2); expect(wait).toHaveBeenCalledOnce();
});
