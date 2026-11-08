export interface SlotStatus { is_processing?: boolean; processing_prompt?: boolean; n_prompt_tokens_processed?: number; n_prompt_tokens?: number }
export interface ServerStatus { status?: string; slots?: SlotStatus[] }
export interface ProgressView { message: string; elapsedSeconds: number | null; reassurance: string | null }
export class ProgressTracker {
  private began = Date.now();
  private lastOutput = Date.now();
  private phase: "reading" | "thinking" | "loading" = "thinking";
  begin(phase: "reading" | "thinking" | "loading" = "thinking"): void { this.began = Date.now(); this.lastOutput = Date.now(); this.phase = phase; }
  output(): void { this.lastOutput = Date.now(); this.phase = "thinking"; }
  view(status?: ServerStatus): ProgressView {
    const seconds = Math.floor((Date.now() - this.began) / 1000);
    const slotReading = status?.slots?.some((slot) => slot.processing_prompt || typeof slot.n_prompt_tokens_processed === "number" && typeof slot.n_prompt_tokens === "number" && slot.n_prompt_tokens_processed < slot.n_prompt_tokens);
    return {
      message: this.phase === "loading" || status?.status === "loading" ? "Starting your private assistant..." : slotReading || this.phase === "reading" ? "Reading your project..." : "Thinking...",
      elapsedSeconds: seconds >= 10 ? seconds : null,
      reassurance: Date.now() - this.lastOutput >= 60000 ? "Still working. Large models on this computer can take a few minutes." : null
    };
  }
}
