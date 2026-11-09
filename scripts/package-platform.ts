import { targetFor } from "../dist/portable/platform.js";
import { resolve } from "node:path";
import { buildPlatform } from "../dist/portable/package.js";
function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`); const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) { throw new Error(`Missing --${name}`); }
  return resolve(value);
}
const target = targetFor(process.platform, process.arch);
await buildPlatform(process.cwd(), argument("out"), target, { app: argument("app"), node: argument("node"), server: argument("server"), lite: argument("lite"), nodeLicense: argument("node-license"), serverLicense: argument("server-license"), desktopLicenses: argument("desktop-licenses"), ...(process.argv.includes("--max") ? { max: argument("max") } : {}), maxRelease: process.argv.includes("--max-release") });
