import { basename, dirname } from "node:path";

// The all-devices stick keeps every app at the top and everything they share in one folder:
//   Stick AI.app  Stick AI.exe  stick-ai  Stellan/{manifest.json, app, bin, models, ...}
// The "root" used everywhere else is that Stellan folder; platform packages keep the apps inside it.
export const sharedFolder = "Stellan";
export const desktopApps = ["Stick AI.app", "Stick AI.exe", "stick-ai"] as const;
export function isSharedLayout(root: string): boolean { return basename(root) === sharedFolder; }
/** The folder that holds the desktop apps for this stick root. */
export function appFolder(root: string): string { return isSharedLayout(root) ? dirname(root) : root; }
/** The top-level app entry a manifest path belongs to, if any. */
export function desktopEntry(path: string): string | undefined { return desktopApps.find((app) => path === app || path.startsWith(`${app}/`)); }
