export class ThinkingParser {
  private pending = "";
  private thinking = false;
  constructor(private emit: (text: string, thinking: boolean) => void) {}
  push(text: string): void {
    this.pending += text;
    while (this.pending) {
      const tag = this.thinking ? "</think>" : "<think>";
      const index = this.pending.indexOf(tag);
      if (index >= 0) {
        this.emit(this.pending.slice(0, index), this.thinking);
        this.pending = this.pending.slice(index + tag.length);
        this.thinking = !this.thinking;
      } else {
        let keep = Math.min(tag.length - 1, this.pending.length);
        while (keep && !tag.startsWith(this.pending.slice(-keep))) { keep--; }
        const length = this.pending.length - keep;
        if (length) { this.emit(this.pending.slice(0, length), this.thinking); }
        this.pending = this.pending.slice(length);
        break;
      }
    }
  }
  finish(): void {
    if (this.pending) { this.emit(this.pending, this.thinking); }
    this.pending = "";
  }
}

export class CodeThinkingStream {
  code = "";
  private pending = "";
  private mode: "prefix" | "think" | "code" = "prefix";
  constructor(private emit: (text: string, thinking: boolean) => void) {}
  push(text: string): void {
    this.pending += text;
    if (this.mode === "prefix") {
      const trimmed = this.pending.trimStart();
      if ("<think>".startsWith(trimmed)) { return; }
      if (trimmed.startsWith("<think>")) { this.pending = trimmed.slice(7); this.mode = "think"; }
      else { this.mode = "code"; }
    }
    if (this.mode === "think") {
      const end = this.pending.indexOf("</think>");
      if (end < 0) {
        const length = Math.max(0, this.pending.length - 7);
        if (length) { this.emit(this.pending.slice(0, length), true); this.pending = this.pending.slice(length); }
        return;
      }
      this.emit(this.pending.slice(0, end), true); this.pending = this.pending.slice(end + 8); this.mode = "code";
    }
    if (this.mode === "code" && this.pending) { this.code += this.pending; this.emit(this.pending, false); this.pending = ""; }
  }
  finish(): void {
    if (this.mode === "prefix") { this.mode = "code"; }
    if (this.mode === "think") { this.emit(this.pending, true); this.pending = ""; }
    else { this.push(""); }
  }
}
