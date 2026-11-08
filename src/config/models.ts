import { totalmem } from "node:os";

export const GiB = 1024 ** 3;
export const maxMinimumBytes = 16 * GiB;
export const modelNames = ["stellan-1-lite", "stellan-1-max"] as const;
export type ModelName = typeof modelNames[number];
export interface RamStatus {
  totalBytes: number;
  totalGB: number;
  maxLocked: boolean;
  forceMax: boolean;
  lockMessage: string;
  warning: string | null;
}
export function ramStatus(totalBytes = totalmem(), forceMax = false): RamStatus {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) { throw new Error("Cannot determine total system RAM"); }
  const totalGB = Math.floor(totalBytes / GiB * 100) / 100;
  return {
    totalBytes, totalGB, maxLocked: totalBytes < maxMinimumBytes && !forceMax, forceMax,
    lockMessage: `Stellan-1 Max needs 16GB RAM or more. Your Mac has ${totalGB} GB.`,
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
    { name: "stellan-1-max", label: "Stellan-1 Max", disabled: ram.maxLocked, message: ram.maxLocked ? ram.lockMessage : null }
  ];
}
export function renderModelPicker(ram: RamStatus, tty: boolean): string {
  return modelChoices(ram).map((choice, index) => {
    const text = `${index + 1}. ${choice.label}${choice.message ? ` (disabled) — ${choice.message}` : ""}`;
    return choice.disabled && tty ? `\x1b[90m${text}\x1b[0m` : text;
  }).join("\n");
}
export function pickModel(input: string, current: ModelName, ram: RamStatus): ModelName {
  const value = input.trim();
  return assertModelAllowed(value === "1" ? "stellan-1-lite" : value === "2" ? "stellan-1-max" : value || current, ram);
}
