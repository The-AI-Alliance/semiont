/**
 * Server construction — the four request handlers, wired to a client.
 *
 * Separate from `index.ts` so the wiring can be driven over an in-memory
 * transport in tests; `index.ts` owns only the process concerns (config,
 * HTTP transports, stdio, signals).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { callTool, type McpClient } from './handlers.js';
import { TOOLS } from './tools.js';

export const SERVER_INFO = { name: 'semiont-mcp', version: '0.2.0' };

/**
 * Build the MCP server over a Semiont client. Every request handler is
 * registered; the caller connects a transport.
 */
export function createServer(semiont: McpClient): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(semiont, request.params.name, request.params.arguments),
  );

  return server;
}
