import type {JSONRPCMessage} from './mcp-types.js';

export class McpWireError extends Error {
  constructor() { super('Invalid or oversized MCP message'); this.name = 'McpWireError'; }
}
function fail(): never { throw new McpWireError(); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const id = (value: unknown) => typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value);
const has = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key);

function boundedJson(value: unknown) {
  let nodes = 0, bytes = 0;
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 64) fail();
    if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8');
    else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); bytes += 24; }
    else if (Array.isArray(item) || object(item)) {
      if (seen.has(item)) fail(); seen.add(item);
      if (Array.isArray(item)) for (const entry of item) visit(entry, depth + 1);
      else for (const [key, entry] of Object.entries(item)) { bytes += Buffer.byteLength(key, 'utf8') + 3; visit(entry, depth + 1); }
      seen.delete(item);
    } else fail();
    if (bytes > 4 * 1024 ** 2) fail();
  };
  visit(value, 0);
}
function metadata(value: Record<string, unknown>) {
  if (!has(value, '_meta')) return;
  const meta = value._meta;
  if (!object(meta)) fail();
  if (has(meta, 'progressToken') && !id(meta.progressToken)) fail();
  const related = meta['io.modelcontextprotocol/related-task'];
  if (related !== undefined && (!object(related) || typeof related.taskId !== 'string')) fail();
}

/** Original bounded envelope validation; operation-specific results remain separately validated. */
export function parseMcpMessage(input: unknown): JSONRPCMessage {
  boundedJson(input);
  if (!object(input) || input.jsonrpc !== '2.0') return fail();
  let keys: string[];
  if (has(input, 'method')) {
    keys = ['jsonrpc', 'method', 'id', 'params'];
    if (typeof input.method !== 'string' || has(input, 'id') && !id(input.id)) fail();
    if (has(input, 'params')) { if (!object(input.params)) fail(); metadata(input.params); }
  } else if (has(input, 'result')) {
    keys = ['jsonrpc', 'id', 'result'];
    if (!id(input.id) || !object(input.result)) fail();
    metadata(input.result);
  } else if (has(input, 'error')) {
    keys = ['jsonrpc', 'id', 'error'];
    if (has(input, 'id') && !id(input.id)) fail();
    const error = input.error;
    if (!object(error) || !Number.isSafeInteger(error.code) || typeof error.message !== 'string') fail();
  } else return fail();
  if (Object.keys(input).some(key => !keys.includes(key))) fail();
  return input as JSONRPCMessage;
}
