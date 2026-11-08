import { resolve } from "node:path";
import { buildStick } from "../dist/portable/build.js";
import { targets, type Target } from "../dist/portable/platform.js";

const args = process.argv.slice(2);
function argument(name: string): string {
  const index = args.indexOf(`--${name}`); const value = args[index + 1];
  if (index < 0 || !value || value.startsWith("--")) { throw new Error(`Missing required build argument --${name}`); }
  return resolve(value);
}
const servers = {} as Record<Target, string>;
const nodes = {} as Record<Target, string>;
const nodeLicenses = {} as Record<Target, string>;
const desktop = {} as Record<Target, string>;
const support: Partial<Record<Target, string>> = {};
for (const target of targets) {
  desktop[target] = argument(`desktop-${target}`);
  servers[target] = argument(target); nodes[target] = argument(`node-${target}`); nodeLicenses[target] = argument(`node-license-${target}`);
  if (args.includes(`--support-${target}`)) { support[target] = argument(`support-${target}`); }
}
const output = args.includes("--out") ? argument("out") : resolve("dist/stick_ai_stick");
await buildStick(process.cwd(), output, { servers, nodes, nodeLicenses, support, desktop, desktopLicenses: argument("desktop-licenses"), lite: argument("lite"), max: argument("max") });
console.log(`Built USB tree: ${output}`);
