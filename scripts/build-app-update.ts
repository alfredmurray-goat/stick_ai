import { resolve } from "node:path";
import { readUpdateConfig } from "../dist/portable/update.js";
import { buildUpdateBundle } from "../dist/portable/update-package.js";
const root = resolve(process.argv[2] ?? "dist/Stick AI");
const config = await readUpdateConfig(root);
await buildUpdateBundle(root, config.target, resolve(process.argv[3] ?? `dist/stick_ai-update-${config.target}.gz`), true);
