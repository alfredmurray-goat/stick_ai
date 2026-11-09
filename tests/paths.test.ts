import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import { isInside, resolveProjectPath, type PathIO } from "../src/sandbox/paths.js";

function filesystem(platform: NodeJS.Platform, root: string, insensitive: boolean, links: Record<string, string> = {}): PathIO {
  const api = platform === "win32" ? win32 : posix;
  const key = (path: string): string => insensitive ? api.normalize(path).toLowerCase() : api.normalize(path);
  const directories = [root, api.join(root, "src")];
  const canonical = new Map(directories.map((path) => [key(path), path]));
  const notFound = (): never => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  return {
    async realpath(path) {
      if (links[path]) { return links[path]; }
      return canonical.get(key(path)) ?? notFound();
    },
    async lstat(path) {
      if (!canonical.has(key(path)) && !links[path]) { notFound(); }
      return { isDirectory: () => !links[path], isFile: () => false, isSymbolicLink: () => Boolean(links[path]), nlink: 1 };
    }
  };
}
for (const platform of ["linux", "darwin", "win32"] as const) {
  describe(`${platform} path fixtures`, () => {
    const api = platform === "win32" ? win32 : posix;
    const root = platform === "win32" ? "C:\\Work\\Project" : "/Work/Project";
    const insensitive = platform !== "linux";
    it("canonicalizes an existing ancestor before resolving a new file", async () => {
      const io = filesystem(platform, root, insensitive);
      expect(await resolveProjectPath(root, "src/new.txt", false, { platform, caseInsensitive: insensitive, io })).toBe(api.join(root, "src", "new.txt"));
    });
    it("rejects traversal, drive-relative, drive-absolute and UNC inputs", async () => {
      const io = filesystem(platform, root, insensitive);
      for (const path of ["../other", "a/../../other", "C:other", "C:\\other", "D:\\other", "\\server\\share\\other", "/other"]) {
        await expect(resolveProjectPath(root, path, false, { platform, io })).rejects.toThrow();
      }
    });
    it("rejects a symlink target outside the root even with a similar name", async () => {
      const link = api.join(root, "escape");
      const io = filesystem(platform, root, insensitive, { [link]: `${root}-other` });
      await expect(resolveProjectPath(root, "escape", false, { platform, caseInsensitive: insensitive, io })).rejects.toThrow("outside");
    });
    it("allows an internal symlink and returns its canonical target", async () => {
      const io = filesystem(platform, root, insensitive, { [api.join(root, "alias")]: api.join(root, "src") });
      expect(await resolveProjectPath(root, "alias", false, { platform, caseInsensitive: insensitive, io })).toBe(api.join(root, "src"));
    });
    it("uses the fixture filesystem's case policy", async () => {
      const io = filesystem(platform, root, insensitive);
      expect(await resolveProjectPath(root, insensitive ? "SRC/new.txt" : "src/new.txt", false, { platform, caseInsensitive: insensitive, io })).toBe(api.join(root, "src", "new.txt"));
      expect(isInside(root, root.toLowerCase(), platform, true)).toBe(true);
      expect(isInside(root, root.toLowerCase(), platform, false)).toBe(false);
    });
  });
}
it("handles UNC roots, cross-drive targets and Windows device aliases", async () => {
  const root = "\\\\server\\share\\Project";
  const io = filesystem("win32", root, true);
  expect(await resolveProjectPath(root, "src/new.txt", false, { platform: "win32", io })).toBe(win32.join(root, "src/new.txt"));
  expect(isInside(root, "\\\\server\\different\\Project", "win32")).toBe(false);
  expect(isInside("C:\\Project", "D:\\Project", "win32")).toBe(false);
  for (const path of ["NUL", "con.txt", "a:stream", "name.", "name "]) {
    await expect(resolveProjectPath(root, path, false, { platform: "win32", io })).rejects.toThrow();
  }
});
