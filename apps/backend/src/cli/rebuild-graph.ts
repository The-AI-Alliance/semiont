#!/usr/bin/env node
/**
 * CLI Tool: Rebuild the Graph from Events
 *
 * Emits `weave:rebuild` to the RUNNING stack's bus — the standalone Weaver
 * (WEAVER-ISOLATION D3/D4) clears and replays the graph projection from the
 * event log. Proves that events are the source of truth and the graph is a
 * projection. Requires the backend and weaver to be running.
 *
 * Usage:
 *   npm run rebuild-graph              # Rebuild entire graph
 *   npm run rebuild-graph <resourceId> # Rebuild specific resource
 *
 * Configuration:
 *   ~/.semiontconfig       — services.backend.publicURL
 *   SEMIONT_WORKER_SECRET  — shared secret for the token exchange
 */

import { BehaviorSubject } from 'rxjs';
import { HttpTransport } from '@semiont/http-transport';
import {
  busRequest,
  baseUrl as makeBaseUrl,
  accessToken as makeAccessToken,
  createTomlConfigLoader,
  type AccessToken,
} from '@semiont/core';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { initializeLogger, getLogger } from '../logger';

/** Rebuilds replay full histories — allow far more than the 30 s bus default. */
const REBUILD_TIMEOUT_MS = 10 * 60 * 1000;

async function rebuildGraph(rId?: string) {
  initializeLogger();
  const logger = getLogger();

  const configPath = join(homedir(), '.semiontconfig');
  const tomlReader = {
    readIfExists: (p: string): string | null => existsSync(p) ? readFileSync(p, 'utf-8') : null,
  };
  const envConfig = createTomlConfigLoader(tomlReader, configPath, process.env)(null, 'local');

  const backendPublicURL = envConfig.services?.backend?.publicURL;
  if (!backendPublicURL) {
    throw new Error('services.backend.publicURL is required in ~/.semiontconfig');
  }

  const workerSecret = process.env.SEMIONT_WORKER_SECRET;
  if (!workerSecret) {
    throw new Error('SEMIONT_WORKER_SECRET is required to authenticate with the backend');
  }

  const response = await fetch(`${backendPublicURL}/api/tokens/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: workerSecret, provider: 'semiont', model: 'rebuild-graph' }),
  });
  if (!response.ok) {
    throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
  }
  const { token } = await response.json() as { token: string };

  const tokenSubject = new BehaviorSubject<AccessToken | null>(makeAccessToken(token));
  const transport = new HttpTransport({
    baseUrl: makeBaseUrl(backendPublicURL),
    token$: tokenSubject,
  });

  try {
    if (rId) {
      logger.info('Rebuilding graph for resource', { resourceId: rId });
      await busRequest(transport, 'weave:rebuild', { resourceId: rId }, REBUILD_TIMEOUT_MS);
      logger.info('Resource rebuilt successfully', { resourceId: rId });
    } else {
      logger.info('Rebuilding entire graph');
      logger.info('Note: This clears the database and replays all events');
      await busRequest(transport, 'weave:rebuild', {}, REBUILD_TIMEOUT_MS);
      logger.info('Graph rebuilt successfully');
    }
  } finally {
    transport.dispose();
  }

  logger.info('Rebuild graph completed');
}

// Parse command line arguments: [resourceId]
const args = process.argv.slice(2);
const envFlagIdx = args.indexOf('--environment');
const rId = args.find((_, i) => i !== envFlagIdx && i !== envFlagIdx + 1);

rebuildGraph(rId)
  .catch(err => {
    const logger = getLogger();
    logger.error('Rebuild graph failed', {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  });
