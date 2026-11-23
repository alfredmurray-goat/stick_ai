import { totalmem } from "node:os";

export function launchPlan({ mode, ramBytes = totalmem(), forceMax = false, tokens, maxTokens = 128, threads = 2, context = 8192, kvCache = "f16" }) {
  if (!["f16", "q8_0"].includes(kvCache) || mode === "llama" && kvCache !== "f16") { throw new Error("KV cache must be f16 or q8_0 for Max; Lite uses fixed recurrent state"); }
  if (!["llama", "gpt2"].includes(mode) || !Number.isFinite(ramBytes) || ramBytes < 0) { throw new Error("Unsupported model or memory information"); }
  if (ramBytes < 8 * 1024 ** 3) { throw new Error("Your computer needs at least 8 GB of memory"); }
  if (mode === "gpt2" && ramBytes < 16 * 1024 ** 3 && !forceMax) { throw new Error("Stellan-1 Max needs 16 GB RAM or more"); }
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > 262144 || !tokens.every(id => Number.isInteger(id) && id >= 0)) { throw new Error("Invalid prompt tokens"); }
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096 || !Number.isInteger(threads) || threads < 1 || threads > 64) { throw new Error("Invalid generation limits"); }
  if (!Number.isInteger(context) || context < 1 || context > (mode === "llama" ? 262144 : kvCache === "q8_0" ? 65536 : 32768) || tokens.length + maxTokens > context) { throw new Error("The request exceeds the experimental context limit; shorten it"); }
  return { mode, maxTokens, threads, context, kvCache, warning: mode === "gpt2" && ramBytes < 16 * 1024 ** 3 ? "Max may be very slow or crash on this computer" : null };
}
