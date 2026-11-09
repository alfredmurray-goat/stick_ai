import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const output = resolve(process.argv[2] ?? "dist/desktop-licenses");
const args = ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--format-version", "1", "--locked"];
const target = process.platform === "darwin" ? (process.arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin") : process.platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
args.push("--filter-platform", target);
const metadata = JSON.parse(execFileSync("cargo", args, { encoding: "utf8", maxBuffer: 20000000 }));
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const used = new Set();
function visit(id) { if (used.has(id)) { return; } used.add(id); for (const dependency of nodes.get(id)?.deps ?? []) { visit(dependency.pkg); } }
const rootPackage = metadata.resolve.root ?? metadata.packages.find((pkg) => pkg.name === "stick-ai")?.id;
if (!rootPackage || !nodes.has(rootPackage)) { throw new Error("Missing native root dependency graph"); }
visit(rootPackage);
async function upstreamNotices(pkg, root) {
  const source = JSON.parse(await readFile(join(root, ".cargo_vcs_info.json"), "utf8"));
  const commit = source.git?.sha1;
  const reviewedRepository = pkg.name === "libappindicator-sys" && pkg.version === "0.9.0" && commit === "eafd1e3682a1247f595410266091e9684021cb6f" && pkg.license === "Apache-2.0 OR MIT" ? "https://github.com/tauri-apps/libappindicator-rs" : undefined;
  const repository = new URL(pkg.repository ?? reviewedRepository);
  const parts = repository.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (repository.protocol !== "https:" || repository.hostname !== "github.com" || !/^[a-f0-9]{40}$/.test(commit) || parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part))) { throw new Error("No supported immutable upstream source"); }
  const names = ["LICENSE", "LICENSE.txt", "LICENSE.md", "LICENSE-MIT", "LICENSE-APACHE", "COPYING", "NOTICE"];
  const results = await Promise.allSettled(names.map(async (name) => {
    const url = `https://raw.githubusercontent.com/${parts.join("/")}/${commit}/${name}`;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) { await response.body?.cancel(); return ""; }
    const text = await response.text(); if (text.length > 2000000) { throw new Error("Upstream notice too large"); }
    return `Upstream ${name} at ${url}\n\n${text}`;
  }));
  const texts = results.filter((result) => result.status === "fulfilled" && result.value).map((result) => result.value);
  if (!texts.length) { throw new Error("Upstream notice was not available at the package's source commit"); }
  return texts;
}
const sections = []; const missing = [];
for (const pkg of metadata.packages.filter((pkg) => used.has(pkg.id)).sort((a, b) => a.name.localeCompare(b.name))) {
  if (pkg.name === "stick-ai") { continue; }
  if (!pkg.license) { missing.push(`${pkg.name}@${pkg.version}: missing licence declaration`); continue; }
  const root = dirname(pkg.manifest_path);
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name)).map((entry) => entry.name);
  if (pkg.license_file && !names.includes(pkg.license_file)) { names.push(pkg.license_file); }
  let texts = [];
  try {
    if (names.length) { for (const name of names.sort()) { texts.push(`${name}\n\n${await readFile(join(root, name), "utf8")}`); } }
    else if (pkg.license === "MPL-2.0") { texts = [`MPL-2.0 standard text\n\n${await readFile("licenses/MPL-2.0.txt", "utf8")}`]; }
    else { texts = await upstreamNotices(pkg, root); }
    if (pkg.license.includes("MPL-2.0")) {
      const destination = join(output, "sources", `${pkg.name}-${pkg.version}`);
      await mkdir(dirname(destination), { recursive: true }); await cp(root, destination, { recursive: true });
      texts.push(`The exact published covered source is included at sources/${pkg.name}-${pkg.version}; its file-level notices are retained.`);
    }
  } catch (error) { missing.push(`${pkg.name}@${pkg.version}: ${String(error)}`); continue; }
  sections.push(`## ${pkg.name}@${pkg.version}\n\n${pkg.license}\n\n${pkg.repository ?? pkg.source ?? ""}\n\nExact published source: https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download\n\n${texts.join("\n\n")}`);
}
if (missing.length) { throw new Error(`Missing audited native notices:\n${missing.join("\n")}`); }
await mkdir(output, { recursive: true });
await writeFile(join(output, "RUST_DEPENDENCIES.md"), sections.join("\n\n") + "\n");
