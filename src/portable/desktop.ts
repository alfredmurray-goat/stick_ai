import { totalmem } from "node:os";
import { portableModels, targetFor } from "./platform.js";

export interface DesktopDriver {
  verify(): Promise<void>;
  prepare(): Promise<void>;
  startLite(): Promise<void>;
  waitHealthy(): Promise<void>;
  openChat(): Promise<void>;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}
export async function launchDesktop(driver: DesktopDriver, signal: AbortSignal, bytes = totalmem()): Promise<() => Promise<void>> {
  portableModels(bytes, true);
  const stop = async (): Promise<void> => { try { await driver.stop(); } finally { await driver.cleanup(); } };
  try {
    for (const step of [() => driver.verify(), () => driver.prepare(), () => driver.startLite(), () => driver.waitHealthy(), () => driver.openChat()]) { signal.throwIfAborted(); await step(); }
    signal.throwIfAborted(); return stop;
  } catch (error) { await stop(); throw error; }
}
export function desktopDryRun(root: string, platform = process.platform, arch = process.arch, bytes = totalmem()): string[] {
  const target = targetFor(platform, arch); const models = bytes < 8 * 1024 ** 3 ? [] : portableModels(bytes, true);
  return [
    bytes < 8 * 1024 ** 3 ? "Memory check would stop launch: this computer needs at least 8 GB; the following actions are a preview only." : "Memory check permits Lite startup.",
    `Select ${target} under ${root}; show the welcome screen with one Start button.`,
    `Check memory; default to Lite; Max is ${models.length === 2 ? "available" : "locked"}.`,
    "Verify SHA256 hashes of the runtime, app, model and server before execution.",
    "Create private temporary storage and use the desktop app log folder.",
    "Reserve an unused 127.0.0.1 port from 8080 through 8099; refuse an occupied listener.",
    "Start the hidden Lite server; poll health and authenticated identity until ready or cancelled.",
    "Open the local chat inside the desktop window without a terminal or browser address bar.",
    "On Cancel, abort only the current step; on quit, stop owned processes and delete temporary files."
  ];
}
