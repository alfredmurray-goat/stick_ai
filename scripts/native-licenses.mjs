import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const output = resolve(process.argv[2] ?? "dist/desktop-licenses");
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--format-version", "1", "--locked"], { encoding: "utf8", maxBuffer: 20000000 }));
const sections = [];
for (const pkg of metadata.packages.sort((a, b) => a.name.localeCompare(b.name))) {
  if (pkg.name === "stick-ai") { continue; }
  if (!pkg.license) { throw new Error(`Review the licence for ${pkg.name}`); }
  const root = dirname(pkg.manifest_path);
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name)).map((entry) => entry.name);
  if (pkg.license_file && !names.includes(pkg.license_file)) { names.push(pkg.license_file); }
  if (!names.length) { throw new Error(`Supply missing upstream licence text for ${pkg.name}@${pkg.version} before redistributing`); }
  const texts = [];
  for (const name of names.sort()) { texts.push(`${name}\n\n${await readFile(join(root, name), "utf8")}`); }
  sections.push(`## ${pkg.name}@${pkg.version}\n\n${pkg.license}\n\n${pkg.repository ?? pkg.source ?? ""}\n\n${texts.join("\n\n")}`);
}
await mkdir(output, { recursive: true });
await writeFile(join(output, "RUST_DEPENDENCIES.md"), sections.join("\n\n") + "\n");
