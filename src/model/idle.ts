export class ModelIdleError extends Error {
  readonly code = "MODEL_IDLE";
  constructor() { super("The model stopped sending bytes for the configured inactivity interval"); this.name = "ModelIdleError"; }
}
export function idleSeconds(value = process.env.STICK_IDLE_TIMEOUT_SECONDS): number {
  const seconds = value === undefined ? 300 : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) { throw new Error("STICK_IDLE_TIMEOUT_SECONDS must be between 0 and 86400 seconds"); }
  return seconds;
}
export class IdleWatchdog {
  private controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  constructor(private seconds = idleSeconds()) { this.touch(1); }
  get signal(): AbortSignal { return this.controller.signal; }
  touch(bytes: number): void {
    if (!bytes || this.controller.signal.aborted) { return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(new ModelIdleError()), this.seconds * 1000);
    this.timer.unref();
  }
  dispose(): void { clearTimeout(this.timer); }
}
