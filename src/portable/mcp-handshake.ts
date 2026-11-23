import {McpWireError, parseMcpMessage} from './mcp-wire.js';

// These are the protocol versions our transports currently negotiate, not an automatic latest-version claim.
export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(): never { throw new McpWireError(); }

export interface McpInitialization {
  protocolVersion: string;
  capabilities: {tools?: {listChanged?: boolean}};
  serverInfo: {name: string; version: string};
}

/** Validate and retain only initialization fields used by our tool-only client. */
export function parseMcpInitialization(input: unknown): McpInitialization {
  // Apply the same bounded JSON/result metadata rules to direct callers and remote replies.
  parseMcpMessage({jsonrpc:'2.0',id:0,result:input});
  if (!object(input) || typeof input.protocolVersion !== 'string' || !object(input.capabilities) || !object(input.serverInfo)) fail();
  const server = input.serverInfo;
  if (typeof server.name !== 'string' || typeof server.version !== 'string') fail();
  for (const key of ['title','websiteUrl','description']) if (key in server && typeof server[key] !== 'string') fail();
  if ('instructions' in input && typeof input.instructions !== 'string') fail();
  const tools = input.capabilities.tools;
  if (tools !== undefined && (!object(tools) || 'listChanged' in tools && typeof tools.listChanged !== 'boolean')) fail();
  return {protocolVersion:input.protocolVersion,capabilities:tools === undefined ? {} : {tools:{...('listChanged' in tools ? {listChanged:tools.listChanged as boolean} : {})}},serverInfo:{name:server.name,version:server.version}};
}
