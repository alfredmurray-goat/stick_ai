import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, rename } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";
const directory = resolve(process.argv[2] ?? "release-assets"); await mkdir(directory, { recursive: true });
const runtimes = {
  "darwin-arm64": ["darwin-arm64.tar.gz", "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7"],
  "darwin-x64": ["darwin-x64.tar.gz", "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035"],
  "win32-x64": ["win-x64.zip", "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5"],
  "linux-x64": ["linux-x64.tar.gz", "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c"]
};
const runtime = runtimes[`${process.platform}-${process.arch}`];
if (!runtime) { throw new Error("Unsupported release platform"); }
const runtimeName = `node-v24.22.1-${runtime[0]}`;
const assets = [
  { name: "stellan-1-lite-q4_k_m.gguf", url: "https://huggingface.co/OfficialSejeGed/stellan-1-lite-gguf/resolve/94f4d2ffd0990289cda48d9505844f90ac6e7144/stellan-1-lite-q4_k_m.gguf", sha256: "84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e", size: 4147481440 },
  { name: runtimeName, url: `https://nodejs.org/dist/v24.22.1/${runtimeName}`, sha256: runtime[1] }
];
for (const asset of assets) {
  const output = join(directory, asset.name); const temporary = output + ".part";
  try {
    console.log(`Downloading verified release input: ${asset.name}`);
    const response = await fetch(asset.url); if (!response.ok || !response.body) { throw new Error(`Download failed: HTTP ${response.status}`); }
    let size = 0; const hash = createHash("sha256");
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } }), createWriteStream(temporary, { flags: "wx" }));
    if (hash.digest("hex") !== asset.sha256 || asset.size && asset.size !== size) { throw new Error(`Release input integrity mismatch: ${asset.name}`); }
    await rename(temporary, output); console.log(`Verified ${asset.name}`);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
