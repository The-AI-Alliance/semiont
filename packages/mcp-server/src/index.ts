#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SemiontClient } from '@semiont/sdk';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';
import type { AccessToken } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

import { readConfig } from './config.js';
import { callTool } from './handlers.js';
import { TOOLS } from './tools.js';

/**
 * Semiont MCP Server
 *
 * Exposes the Semiont verb-oriented API to AI applications via MCP tools.
 * Tools are named by flow: browse, mark, bind, gather, match, yield.
 */

const config = readConfig(process.env);

const transport = new HttpTransport({
  baseUrl: config.apiUrl,
  token$: new BehaviorSubject<AccessToken | null>(config.token),
});
const semiont = new SemiontClient(transport, new HttpContentTransport(transport), transport);

const server = new Server(
  { name: 'semiont-mcp', version: '0.2.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(semiont, request.params.name, request.params.arguments),
);

async function main() {
  console.error('[MCP] Starting semiont-mcp v0.2.0');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Connected');

  process.on('SIGINT', async () => { await server.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.close(); process.exit(0); });

  await new Promise(() => {});
}

main().catch((error) => {
  console.error('[MCP] Fatal:', error);
  process.exit(1);
});
