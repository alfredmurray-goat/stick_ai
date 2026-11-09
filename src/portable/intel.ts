import { buildPlatform, type PlatformInputs } from "./package.js";
export type IntelInputs = PlatformInputs;
export function buildIntel(project: string, output: string, input: IntelInputs) {
  return buildPlatform(project, output, "macos-x64", input);
}
