// What a locked copy of each official model contains (see model-lock.ts). The split is the same every
// time, so these were measured once from the pinned GGUFs with splitDigest and are checked like any
// other file: the plain second split by its hash, the locked first split by its size here and by its
// decrypted hash when the app unlocks it.
import { lockedNames, lockOverhead } from "./model-lock.js";
import type { FileRecord } from "./integrity.js";

export interface LockedModel { base: string; label: string; firstSha256: string; firstSize: number; restSha256: string; restSize: number }
export const lockedModels: Record<"stellan-1-lite" | "stellan-1-max", LockedModel> = {
  "stellan-1-lite": { base: "models/stellan-1-lite-q4_k_m", label: "stellan-1-lite", firstSha256: "5bec638a54313160edcbea54a60dd2805f8eeda37eff580fa528dec871abd38e", firstSize: 77277952, restSha256: "b7a288d0a3d7c1d36f612f162c8e3f107f3b4cce14e3092510f74cc9edf375b6", restSize: 4070203680 },
  "stellan-1-max": { base: "models/stellan-1.0-q4_k_m", label: "stellan-1-max", firstSha256: "9a85f721ca16bbd94525ec7f653b3720bd7f78f40a421382f0797b7c6a0e54bd", firstSize: 84422624, restSha256: "82ccefd4aa6bfe3c3c0083ac3661a6378ebe363cffec73e06edc10d0929d4189", restSize: 14249492800 }
};
/** Manifest entries for a locked model; optional, like the plain model files, so sticks without it pass. */
export function lockedRecords(model: LockedModel): FileRecord[] {
  const names = lockedNames(model.base);
  return [
    { path: names.locked, sha256: model.firstSha256, size: model.firstSize + lockOverhead, executable: false, optional: true, locked: true },
    { path: names.rest, sha256: model.restSha256, size: model.restSize, executable: false, optional: true }
  ];
}
export const lockedModelPaths = new Set<string>(Object.values(lockedModels).flatMap((model) => lockedRecords(model).map((record) => record.path)));
export const optionalModelPaths = new Set<string>(["models/stellan-1.0-q4_k_m.gguf", "models/stellan-1-lite-q4_k_m.gguf", ...lockedModelPaths]);
