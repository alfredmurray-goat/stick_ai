import { resolve } from "node:path";
import { buildIntel } from "../dist/portable/intel.js";
function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`); const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) { throw new Error(`Missing --${name}`); }
  return resolve(value);
}
await buildIntel(process.cwd(), argument("out"), { app: argument("app"), node: argument("node"), server: argument("server"), lite: argument("lite"), nodeLicense: argument("node-license"), serverLicense: argument("server-license"), desktopLicenses: argument("desktop-licenses") });
