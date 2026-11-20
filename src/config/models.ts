import { totalmem } from "node:os";

export const GiB = 1024 ** 3;
// Max is a 14.3 GB file. On a 16 GB machine it loads but keeps re-reading itself from disk (no answer in 20
// minutes on a 16 GB cloud machine), so it is only recommended with 24 GB. 16 GB computers may still choose
// it after a warning. Computers report a little less than their nominal memory once firmware and integrated
// graphics take their share, hence 15 GiB for "16 GB" and 22 GiB for "24 GB".
export const maxMinimumBytes = 15 * GiB;
// Lite peaks at about 4.5 GB. Computers sold with 8 GB often report 7.6-7.9 GiB once integrated graphics
// and firmware take their share, so the check is 7 GiB.
export const liteMinimumBytes = 7 * GiB;
export const maxRecommendedBytes = 22 * GiB;
export function maxSlowWarning(totalGB: number): string {
  return `Max may be very slow on this computer, or seem stuck: it has ${totalGB} GB of memory and Max works best with 24 GB or more. A reply can take many minutes. Lite runs well here.`;
}
export const modelNames = ["stellan-1-lite", "stellan-1-max"] as const;
export type ModelName = typeof modelNames[number];
export interface RamStatus {
  totalBytes: number;
  totalGB: number;
  maxLocked: boolean;
  maxSlow: boolean;
  slowMessage: string;
  forceMax: boolean;
  lockMessage: string;
  warning: string | null;
}
export function ramStatus(totalBytes = totalmem(), forceMax = false): RamStatus {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) { throw new Error("Cannot determine total system RAM"); }
  const totalGB = Math.floor(totalBytes / GiB * 100) / 100;
  return {
    totalBytes, totalGB, maxLocked: totalBytes < maxMinimumBytes && !forceMax, maxSlow: totalBytes < maxRecommendedBytes, slowMessage: maxSlowWarning(totalGB), forceMax,
    lockMessage: `Stellan-1 Max needs a computer with at least 16 GB of memory (24 GB recommended). This one has ${totalGB} GB.`,
    warning: forceMax ? "Warning: --force-max is enabled. Stellan-1 Max may be very slow or crash." : null
  };
}
export function modelName(value: string): ModelName {
  if (!modelNames.includes(value as ModelName)) { throw new Error(`Unknown model: ${value}. Choose stellan-1-lite or stellan-1-max.`); }
  return value as ModelName;
}
export function assertModelAllowed(value: string, ram: RamStatus): ModelName {
  const selected = modelName(value);
  if (selected === "stellan-1-max" && ram.maxLocked) { throw new Error(`${ram.lockMessage} Use --force-max to override.`); }
  return selected;
}
export function modelChoices(ram: RamStatus): { name: ModelName; label: string; disabled: boolean; message: string | null }[] {
  return [
    { name: "stellan-1-lite", label: "Stellan-1 Lite", disabled: false, message: null },
    { name: "stellan-1-max", label: "Stellan-1 Max", disabled: ram.maxLocked, message: ram.maxLocked ? ram.lockMessage : ram.maxSlow ? "very slow on this computer" : null }
  ];
}
export function renderModelPicker(ram: RamStatus, tty: boolean): string {
  return modelChoices(ram).map((choice, index) => {
    const text = `${index + 1}. ${choice.label}${choice.message ? `${choice.disabled ? " (disabled)" : ""} — ${choice.message}` : ""}`;
    return choice.disabled && tty ? `\x1b[90m${text}\x1b[0m` : text;
  }).join("\n");
}
export function pickModel(input: string, current: ModelName, ram: RamStatus): ModelName {
  const value = input.trim();
  return assertModelAllowed(value === "1" ? "stellan-1-lite" : value === "2" ? "stellan-1-max" : value || current, ram);
}
