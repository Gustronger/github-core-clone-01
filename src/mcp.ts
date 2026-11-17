// MCP surface: POST /mcp — JSON-RPC 2.0 over Streamable HTTP, the
// server/discover handshake (revision 2026-07-28) with the legacy
// initialize fallback, tools/list and the six tools. Implemented in the MCP
// step (PLAN §i step 8) against checks-mcp.ts: the checks there are the spec.

import { sendError, type Handler } from './context.ts';

/** Placeholder until the MCP surface lands: the endpoint is a JSON 404. */
export const handleMcp: Handler = (_req, res, ctx) => {
  sendError(res, 404, 'Not Found', ctx.requestId);
};
