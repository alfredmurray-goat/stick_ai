const limit = 4 * 1024 ** 2;

/** Bounded NDJSON framing without recopying the accumulated prefix on every chunk. */
export class McpLines {
 constructor(private includeEmpty = false) {}
 private buffer = Buffer.alloc(0);
 private used = 0;
 get bufferedBytes() { return this.used; }
 get capacityBytes() { return this.buffer.length; }
 clear() { this.buffer = Buffer.alloc(0); this.used = 0; }
 push(chunk: Buffer, consume: (line: Buffer) => void) {
  let start = 0;
  while (start < chunk.length) {
   const end = chunk.indexOf(10, start), stop = end < 0 ? chunk.length : end;
   const part = chunk.subarray(start, stop), needed = this.used + part.length;
   if (needed > limit) throw Error('MCP message is too large');
   if (end >= 0 && this.used === 0) {
    if (part.length || this.includeEmpty) consume(part);
   } else {
    if (needed > this.buffer.length) {
     const next = Buffer.allocUnsafe(Math.min(limit, Math.max(4096, this.buffer.length * 2, needed)));
     this.buffer.copy(next, 0, 0, this.used); this.buffer = next;
    }
    part.copy(this.buffer, this.used); this.used = needed;
    if (end >= 0) {
     if (this.used || this.includeEmpty) consume(this.buffer.subarray(0, this.used));
     this.used = 0;
     if (this.buffer.length > 65536) this.clear();
    }
   }
   if (end < 0) break;
   start = end + 1;
  }
 }
}
