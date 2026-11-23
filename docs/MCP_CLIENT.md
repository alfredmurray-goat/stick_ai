# Original MCP client — first slice

The `feat/stellan-mcp-client` branch starts replacing the SDK's generic wire-envelope validation with our own `parseMcpMessage` in `src/portable/mcp-wire.ts`. The existing original `McpRpc` lifecycle and supervised process transport use it before dispatch. It validates JSON-RPC requests, notifications, successful/error responses, IDs, metadata and exclusive envelope fields, with bounded nesting, node count and aggregate content. Stdio keeps its existing line-size and UTF-8 checks.

This is a staged compatibility change, not a complete replacement SDK. Initialization and operation-specific result schemas, negotiated protocol-version definitions, HTTP/SSE transports and type declarations still use `@modelcontextprotocol/sdk`; `cross-spawn` remains. No dependency has been removed yet, and no speed, bundle-size or RAM improvement is claimed. New protocol revisions require explicit compatibility review rather than silently changing the supported contract.

Independent valid/malformed fixtures are cross-checked against the pinned SDK's envelope schema in tests only. Existing packaged stdio, HTTP/SSE, Actuent, cancellation and approval integration tests still run. The wire layer rejects ambiguous envelopes, invalid metadata, non-JSON/cyclic objects, oversized content and excessive nesting. Tool calls retain their approvals, remote-origin/credential restrictions and process isolation behavior.

Next: implement and verify original initialization/tool-result validation, then HTTP/SSE transport/session/authorization behavior for each supported protocol version. Remove the runtime SDK only after interoperability and malformed-input tests cover those responsibilities. See the [replacement roadmap](OWN_COMPONENTS.md).
