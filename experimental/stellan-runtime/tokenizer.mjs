import { open } from "node:fs/promises";

class Reader {
  constructor(bytes) { this.bytes = bytes; this.position = 0; }
  take(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.position) { throw new Error("Model header exceeds supported bounds"); }
    const result = this.bytes.subarray(this.position, this.position + size);
    this.position += size;
    return result;
  }
  u32() { return this.take(4).readUInt32LE(); }
  u64() {
    const value = this.take(8).readBigUInt64LE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) { throw new Error("Model header integer exceeds limits"); }
    return Number(value);
  }
  string() {
    const length = this.u64();
    if (length > 1048576) { throw new Error("Model header string exceeds limits"); }
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length));
  }
  value(type, keep, depth = 0) {
    if (type === 8) { const value = this.string(); return keep ? value : undefined; }
    if (type === 9) {
      const element = this.u32();
      const count = this.u64();
      if (depth !== 0 || count > 1000000 || element === 9) { throw new Error("Unsupported model header array"); }
      const values = [];
      for (let i = 0; i < count; i++) { const value = this.value(element, keep, 1); if (keep) { values.push(value); } }
      return keep ? values : undefined;
    }
    const widths = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
    if (!(type in widths)) { throw new Error("Unsupported model header value"); }
    const bytes = this.take(widths[type]);
    if (!keep) { return undefined; }
    if (type === 6) { return bytes.readFloatLE(); }
    if (type === 7) { return bytes[0] !== 0; }
    if (type === 5) { return bytes.readInt32LE(); }
    if (type === 4) { return bytes.readUInt32LE(); }
    throw new Error("Unsupported tokenizer metadata value");
  }
}

export async function readTokenizer(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const bytes = Buffer.alloc(Math.min(stat.size, 32 * 1024 * 1024));
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (result.bytesRead === 0) { throw new Error("Model header was truncated"); }
      count += result.bytesRead;
    }
    const reader = new Reader(bytes);
    if (reader.u32() !== 0x46554747 || ![2, 3].includes(reader.u32())) { throw new Error("Unsupported model format"); }
    reader.u64();
    const entries = reader.u64();
    if (entries > 100000) { throw new Error("Model metadata exceeds limits"); }
    const metadata = new Map();
    for (let i = 0; i < entries; i++) {
      const key = reader.string();
      const value = reader.value(reader.u32(), key.startsWith("tokenizer.ggml."));
      if (key.startsWith("tokenizer.ggml.")) {
        if (metadata.has(key)) { throw new Error("Duplicate tokenizer metadata"); }
        metadata.set(key, value);
      }
    }
    return createTokenizer(metadata);
  } finally { await file.close(); }
}

class Heap {
  values = [];
  better(a, b) { return a.rank === b.rank ? a.left < b.left : a.rank < b.rank; }
  push(value) {
    let index = this.values.push(value) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.better(value, this.values[parent])) { break; }
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }
  pop() {
    const result = this.values[0];
    const last = this.values.pop();
    if (this.values.length > 0) {
      let index = 0;
      while (index * 2 + 1 < this.values.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.values.length && this.better(this.values[child + 1], this.values[child])) { child++; }
        if (this.better(last, this.values[child])) { break; }
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return result;
  }
}

function mergePieces(pieces, rank) {
  const nodes = pieces.map((text, index) => ({ text, next: index + 1, previous: index - 1, version: 0, alive: true }));
  if (nodes.length === 0) { return []; }
  nodes.at(-1).next = -1;
  const heap = new Heap();
  function enqueue(left) {
    if (left < 0 || !nodes[left].alive || nodes[left].next < 0) { return; }
    const right = nodes[left].next;
    const value = rank(nodes[left].text, nodes[right].text);
    if (value !== undefined) { heap.push({ rank: value, left, right, a: nodes[left].version, b: nodes[right].version }); }
  }
  for (let i = 0; i < nodes.length; i++) { enqueue(i); }
  while (heap.values.length > 0) {
    const pair = heap.pop();
    const left = nodes[pair.left];
    const right = nodes[pair.right];
    if (!left.alive || !right.alive || left.next !== pair.right || left.version !== pair.a || right.version !== pair.b) { continue; }
    left.text += right.text;
    left.next = right.next;
    left.version++;
    right.alive = false;
    if (right.next >= 0) { nodes[right.next].previous = pair.left; }
    enqueue(left.previous);
    enqueue(pair.left);
  }
  const result = [];
  for (let i = 0; i >= 0; i = nodes[i].next) { result.push(nodes[i].text); }
  return result;
}

export function createTokenizer(metadata) {
  const vocabulary = metadata.get("tokenizer.ggml.tokens");
  const types = metadata.get("tokenizer.ggml.token_type");
  if (!Array.isArray(vocabulary) || !Array.isArray(types) || vocabulary.length !== types.length || vocabulary.length > 1000000) { throw new Error("Incomplete tokenizer vocabulary"); }
  const lookup = new Map(vocabulary.map((token, index) => [token, index]));
  if (lookup.size !== vocabulary.length) { throw new Error("Duplicate tokenizer vocabulary entry"); }
  const bos = metadata.get("tokenizer.ggml.bos_token_id");
  const eos = metadata.get("tokenizer.ggml.eos_token_id");
  if (![bos, eos].every(id => Number.isInteger(id) && id >= 0 && id < vocabulary.length)) { throw new Error("Invalid boundary token"); }
  const mode = metadata.get("tokenizer.ggml.model");
  const byteCharacters = [];
  const byteValues = new Map();
  let extra = 0;
  for (let byte = 0; byte < 256; byte++) {
    const direct = byte >= 33 && byte <= 126 || byte >= 161 && byte <= 172 || byte >= 174;
    const character = String.fromCodePoint(direct ? byte : 256 + extra++);
    byteCharacters.push(character);
    byteValues.set(character, byte);
  }
  const ranks = new Map((metadata.get("tokenizer.ggml.merges") ?? []).map((pair, index) => [pair, index]));
  const scores = metadata.get("tokenizer.ggml.scores");
  const fallback = new Map();
  vocabulary.forEach((piece, index) => { if (types[index] === 6 && /^<0x[0-9A-Fa-f]{2}>$/.test(piece)) { fallback.set(Number.parseInt(piece.slice(3, 5), 16), index); } });
  if (mode === "gpt2") {
    if (metadata.get("tokenizer.ggml.pre") !== "tekken" || ranks.size === 0) { throw new Error("Unsupported BPE pretokenizer"); }
  } else if (mode !== "llama" || !Array.isArray(scores) || scores.length !== vocabulary.length || fallback.size !== 256) { throw new Error("Unsupported SentencePiece vocabulary"); }
  const specials = vocabulary.filter((piece, index) => types[index] === 3 || types[index] === 4).sort((a, b) => b.length - a.length);
  const specialRegex = new RegExp(specials.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu");
  const tekken = /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
  function ordinary(text, prefix) {
    if (text.length === 0) { return []; }
    let pieces;
    if (mode === "llama") {
      const normalized = (prefix ? "▁" : "") + text.replaceAll(" ", "▁");
      pieces = mergePieces([...normalized], (a, b) => {
        const id = lookup.get(a + b);
        return id === undefined || types[id] !== 1 ? undefined : -scores[id];
      });
    } else {
      pieces = [];
      let consumed = 0;
      for (const match of text.matchAll(tekken)) {
        if (match.index !== consumed) { throw new Error("Tokenizer did not consume the prompt"); }
        consumed += match[0].length;
        const bytes = [...Buffer.from(match[0], "utf8")].map(byte => byteCharacters[byte]);
        pieces.push(...mergePieces(bytes, (a, b) => ranks.get(`${a} ${b}`)));
      }
      if (consumed !== text.length) { throw new Error("Tokenizer did not consume the prompt"); }
    }
    return pieces.flatMap(piece => {
      const id = lookup.get(piece);
      if (id !== undefined && types[id] === 1) { return [id]; }
      if (mode === "gpt2") { throw new Error("BPE piece is missing from the vocabulary"); }
      return [...Buffer.from(piece)].map(byte => fallback.get(byte));
    });
  }
  return {
    mode,
    eos,
    encode(text) {
      if (typeof text !== "string" || Buffer.byteLength(text) > 1048576) { throw new Error("Prompt exceeds limits"); }
      const result = metadata.get("tokenizer.ggml.add_bos_token") === false ? [] : [bos];
      let cursor = 0;
      let prefix = true;
      for (const match of text.matchAll(specialRegex)) {
        result.push(...ordinary(text.slice(cursor, match.index), prefix));
        const id = lookup.get(match[0]);
        if (!(id === bos && match.index === 0 && result.length === 1)) { result.push(id); }
        cursor = match.index + match[0].length;
        prefix = false;
      }
      result.push(...ordinary(text.slice(cursor), prefix));
      if (result.length === 0 || result.length > 262144 || !result.every(Number.isInteger)) { throw new Error("Prompt token count exceeds limits"); }
      return result;
    },
    decodeBytes(id) {
      if (!Number.isInteger(id) || id < 0 || id >= vocabulary.length) { throw new Error("Invalid token ID"); }
      if (id === bos || id === eos) { return Buffer.alloc(0); }
      const piece = vocabulary[id];
      if (mode === "gpt2" && types[id] === 1) {
        const bytes = [...piece].map(character => byteValues.get(character));
        if (!bytes.every(Number.isInteger)) { throw new Error("Invalid byte-encoded vocabulary entry"); }
        return Buffer.from(bytes);
      }
      if (types[id] === 6) { return Buffer.from([Number.parseInt(piece.slice(3, 5), 16)]); }
      return Buffer.from(piece.replaceAll("▁", " "));
    }
  };
}
