import { ModelIdleError } from "../model/idle.js";
import { UserError } from "./platform.js";

export interface FriendlyError { kind: string; message: string; action: "OK" | "Retry" | "Switch to a faster setting"; explanation?: string }
export function friendlyError(error: unknown, idleFailures = 0): FriendlyError {
  if (error instanceof ModelIdleError || error instanceof Error && error.name === "ModelIdleError") {
    return idleFailures >= 2 ? { kind: "idle", message: "This model is taking too long to respond", action: "Switch to a faster setting", explanation: "Use the smaller assistant, send less text at once and avoid switching to the larger model; complex tasks may need smaller steps." } : { kind: "idle", message: "The model has been quiet for a while; please try again", action: "Retry" };
  }
  if (error instanceof Error && error.name === "AbortError") { return { kind: "cancelled", message: "This step was stopped", action: "OK" }; }
  if (error instanceof UserError && error.code === "memory") { return { kind: "memory", message: "Your computer needs at least 8 GB of memory", action: "OK" }; }
  if (error instanceof UserError && error.code === "damaged") { return { kind: "file", message: "This stick may be damaged; ask for a fresh copy", action: "Retry" }; }
  if (error instanceof UserError && ["loading", "busy"].includes(error.code)) { return { kind: "starting", message: "The assistant is still starting; wait a moment and try again", action: "Retry" }; }
  return { kind: "general", message: "This step could not finish; please try again", action: "Retry" };
}
