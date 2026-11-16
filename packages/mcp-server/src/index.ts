#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SemiontClient } from '@semiont/sdk';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';
import type { AccessToken } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

import { readConfig } from './config.js';
import { createServer, SERVER_INFO } from './server.js';

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

const server = createServer(semiont);

async function main() {
  console.error(`[MCP] Starting ${SERVER_INFO.name} v${SERVER_INFO.version}`);
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  console.error('[MCP] Connected');

  process.on('SIGINT', async () => { await server.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.close(); process.exit(0); });

  await new Promise(() => {});
}

main().catch((error) => {
  console.error('[MCP] Fatal:', error);
  process.exit(1);
});
