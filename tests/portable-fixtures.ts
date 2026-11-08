import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { targets } from "../src/portable/platform.js";
import type { StickInputs } from "../src/portable/build.js";

export async function assets(root: string): Promise<StickInputs> {
  const servers = {} as StickInputs["servers"]; const nodes = {} as StickInputs["nodes"]; const nodeLicenses = {} as StickInputs["nodeLicenses"];
  for (const target of targets) {
    const data = Buffer.alloc(4096);
    if (target === "linux-x64") { Buffer.from([127, 69, 76, 70, 2]).copy(data); data.writeUInt16LE(62, 18); }
    else if (target === "windows-x64") { data.write("MZ"); data.writeUInt32LE(128, 60); data.write("PE\0\0", 128); data.writeUInt16LE(0x8664, 132); }
    else { data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(target === "macos-arm64" ? 0x100000c : 0x1000007, 4); }
    servers[target] = join(root, `${target}-server`); nodes[target] = join(root, `${target}-node`); nodeLicenses[target] = join(root, `${target}-license`);
    await writeFile(servers[target], data); await writeFile(nodes[target], data); await writeFile(nodeLicenses[target], "Test fixture only, not a distributable runtime");
  }
  const data = Buffer.alloc(16); data.write("GGUF"); data.writeUInt32LE(3, 4);
  const lite = join(root, "lite.gguf"), max = join(root, "max.gguf"); await writeFile(lite, data); await writeFile(max, data);
  return { servers, nodes, nodeLicenses, lite, max };
}
