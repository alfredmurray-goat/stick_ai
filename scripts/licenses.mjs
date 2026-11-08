import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const seen = new Set();
const sections = [];
async function visit(name, parent) {
  const require = createRequire(join(parent, "package.json"));
  let directory;
  for (const search of require.resolve.paths(name) ?? []) {
    try { await readFile(join(search, name, "package.json")); directory = join(search, name); break; } catch {}
  }
  if (!directory) { throw new Error(`Install missing dependency ${name} before regenerating licences`); }
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) { return; }
  seen.add(key);
  const files = (await readdir(directory)).filter((file) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file)).sort();
  if (!files.length) { throw new Error(`No licence text found for ${key}; review manually`); }
  const texts = await Promise.all(files.map(async (file) => `### ${file}\n\n${(await readFile(join(directory, file), "utf8")).replaceAll("\r\n", "\n")}`));
  sections.push(`## ${key}\n\nDeclared licence: ${JSON.stringify(pkg.license ?? "UNKNOWN")}\n\n${texts.join("\n\n")}`);
  for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) { await visit(dependency, directory); }
}
for (const name of Object.keys(manifest.dependencies ?? {}).sort()) { await visit(name, root); }
const esbuild = JSON.parse(await readFile(join(root, "node_modules/esbuild/package.json"), "utf8"));
if (esbuild.version !== manifest.devDependencies.esbuild || esbuild.license !== "MIT") { throw new Error("Unexpected esbuild build-tool licence or version"); }
sections.push(`## Build tool: esbuild ${esbuild.version} (MIT)\n\nNot shipped as a runtime dependency.\n\n${(await readFile(join(root, "node_modules/esbuild/LICENSE.md"), "utf8")).replaceAll("\r\n", "\n")}`);
sections.push(`## Portable inference: llama.cpp v0.9.0 (MIT)\n\nPortable binaries must be built from pinned upstream tag v0.9.0, https://github.com/ggml-org/llama.cpp/tree/v0.9.0 . Supplied binary provenance must be audited by the release builder; generated SHA256 checksums alone do not prove a source revision. Full upstream notice:\n\n${(await readFile(join(root, "licenses/llama.cpp-MIT.txt"), "utf8")).replaceAll("\r\n", "\n")}`);
sections.push("## Portable Node.js 24.22.1\n\nNode.js is MIT with bundled third-party notices. The USB builder requires each supplied Node runtime's complete release LICENSE file and places it in LICENSES/Node-<platform>.txt. Any llama.cpp sidecar libraries require their corresponding redistribution notices. No runtime binaries are included in this source repository.");
sections.push("## Desktop wrapper: Tauri 2.12.5 (MIT OR Apache-2.0)\n\nhttps://github.com/tauri-apps/tauri . Copyright Tauri Programme within The Commons Conservancy. Direct Rust dependencies: tauri-build 2.7.4 (MIT OR Apache-2.0), serde and serde_json (MIT OR Apache-2.0), sha2 (MIT OR Apache-2.0), tempfile (MIT OR Apache-2.0). No new npm dependencies are added. Each native release must retain its generated Cargo.lock and run node scripts/native-licenses.mjs to gather the complete resolved Rust dependency licence texts. The stick builder requires that directory with --desktop-licenses. Missing texts fail generation and require upstream notice review; this source-only archive does not claim a completed binary redistribution audit. Platform webview libraries keep their own licences and are supplied by the OS. Tauri CLI 2.12.2 is a separate MIT OR Apache-2.0 build tool.");
sections.push(`## Native covered-source notices (MPL-2.0)\n\nThe resolved native build graph includes MPL-2.0 packages such as selectors. The native notice generator includes their exact published source, file-level notices and licence text in LICENSES/desktop/sources and RUST_DEPENDENCIES.md. These third-party files retain their own licence; stick_ai's authored code remains MIT. The complete pinned llama.cpp source archive accompanies native notices to preserve vendored notices as well.\n\n${await readFile(join(root, "licenses/MPL-2.0.txt"), "utf8")}`);
await writeFile(join(root, "THIRD_PARTY_LICENSES.md"), `# Third-party runtime licences\n\nGenerated offline by npm run licenses from package.json runtime dependencies and their installed transitive dependencies. No additional npm dependencies were introduced for cross-platform sandboxing. Node.js child_process/fs/path APIs implement process launching and path rules. Development tools, Node.js, Ollama, Linux bubblewrap, Apple sandbox-exec and Windows PowerShell/cmd/taskkill are separately supplied platform tools with their own licences; they are not bundled or relicensed here. Any optional copied shell runtime retains its original notices.\n\n${sections.length ? sections.sort().join("\n\n") : "This release has no third-party npm runtime dependencies."}\n`);
