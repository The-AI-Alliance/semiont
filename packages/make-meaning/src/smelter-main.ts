/**
 * Smelter Main — standalone entry point
 *
 * Thin wiring for the `Smelter` pipeline: loads configuration from
 * ~/.semiontconfig (TOML) via the canonical `createTomlConfigLoader`,
 * authenticates with the KS via shared secret, constructs the embedding
 * provider, vector store, content transport, and HTTP transport, then
 * hands the SmelterActorStateUnit's event stream to the Smelter and runs
 * a startup reconcile. All event processing lives in `./smelter`.
 *
 * The smelter is a pure network peer: events arrive over SSE, content is
 * fetched over HTTP in verbatim mode (the stored bytes, untouched — the
 * checksum stamp depends on it; SMELTER-AXIOMS.md S12), and its single
 * privileged attachment beyond the bus is the vector store (Qdrant).
 *
 * Environment variables:
 *   SEMIONT_WORKER_SECRET — shared secret for JWT auth with the KS
 */

import { BehaviorSubject } from 'rxjs';
import { createSmelterActorStateUnit, type SmelterActorStateUnit } from './smelter-actor-state-unit';
import { Smelter } from './smelter';
import { HttpTransport, HttpContentTransport } from '@semiont/http-transport';
import { baseUrl as makeBaseUrl, accessToken as makeAccessToken, createTomlConfigLoader } from '@semiont/core';
import type { AccessToken } from '@semiont/core';
import { createVectorStore, createEmbeddingProvider } from '@semiont/vectors';
import type { ChunkingConfig } from '@semiont/vectors';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ───────────────────────────────────────────────────────────

const configPath = join(homedir(), '.semiontconfig');
const tomlReader = {
  readIfExists: (p: string): string | null => existsSync(p) ? readFileSync(p, 'utf-8') : null,
};
const envConfig = createTomlConfigLoader(
  tomlReader,
  configPath,
  process.env,
)(null, 'local');

const backendPublicURL = envConfig.services?.backend?.publicURL;
if (!backendPublicURL) {
  throw new Error('services.backend.publicURL is required in ~/.semiontconfig');
}
const baseUrl: string = backendPublicURL;

const embedding = envConfig.services?.embedding;
if (!embedding?.type || !embedding?.model) {
  throw new Error('services.embedding.{type,model} are required in ~/.semiontconfig');
}
const embeddingType = embedding.type as 'ollama' | 'voyage';
const embeddingModel: string = embedding.model;
const embeddingBaseURL: string = embedding.baseURL ?? embedding.endpoint ?? '';
if (!embeddingBaseURL) {
  throw new Error('services.embedding.baseURL (or endpoint) is required in ~/.semiontconfig');
}

const vectors = envConfig.services?.vectors;
if (!vectors?.host) {
  throw new Error('services.vectors.host is required in ~/.semiontconfig');
}
const qdrantHost: string = vectors.host;
const qdrantPort: number = vectors.port ?? 6333;

const chunkingConfig: ChunkingConfig = {
  chunkSize: embedding.chunking?.chunkSize ?? 512,
  overlap: embedding.chunking?.overlap ?? 64,
};

const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';

const healthPort = 9091;

import { createProcessLogger } from '@semiont/observability/process-logger';
import { registerVectorIndexSizeProvider } from '@semiont/observability';
const logger = createProcessLogger('smelter');

// ── Auth ─────────────────────────────────────────────────────────────

async function authenticate(): Promise<string> {
  if (!workerSecret) {
    logger.warn('No SEMIONT_WORKER_SECRET set — using empty token');
    return '';
  }

  // The smelter is a Software peer just like an inference agent — it
  // authenticates with its (provider, model) so the bus stamps a typed
  // agent DID onto every event it emits. Identity granularity follows
  // the embedding config; two smelters with different embedding
  // providers run as different agents.
  const response = await fetch(`${baseUrl}/api/tokens/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: workerSecret,
      provider: embeddingType,
      model: embeddingModel,
    }),
  });

  if (!response.ok) {
    throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
  }

  const { token } = await response.json() as { token: string; did: string };
  return token;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-smelter' });

  logger.info('Authenticating', { baseUrl });
  const tokenSubject = new BehaviorSubject<AccessToken | null>(makeAccessToken(await authenticate()));
  logger.info('Authenticated');

  // Agent tokens expire (24h — POST /api/tokens/agent). Two recovery paths
  // keep a long-lived worker authenticated: `tokenRefresher` re-authenticates
  // and retries once when any HTTP request 401s, and a proactive re-auth at
  // half the TTL covers the listen-only case — SSE reconnects read `token$`
  // fresh, so pushing here is what keeps the event feed alive.
  const refreshToken = async (): Promise<string | null> => {
    const token = await authenticate();
    tokenSubject.next(makeAccessToken(token));
    return token;
  };
  const reauthTimer = setInterval(() => {
    refreshToken().catch((error) => {
      logger.error('Proactive re-authentication failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 12 * 60 * 60 * 1000);

  const embeddingProvider = await createEmbeddingProvider({
    type: embeddingType,
    model: embeddingModel,
    baseURL: embeddingBaseURL,
  });
  logger.info('Embedding provider ready', { type: embeddingType, model: embeddingModel });

  const dimensions = embeddingProvider.dimensions();
  const vectorStore = await createVectorStore({
    type: 'qdrant',
    host: qdrantHost,
    port: qdrantPort,
    dimensions,
  });
  logger.info('Vector store ready', { host: qdrantHost, port: qdrantPort, dimensions });

  // Tier 3 observability: report index point count. Polled at the
  // metric-collection interval (default 30s).
  registerVectorIndexSizeProvider(() => vectorStore.count());

  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: tokenSubject,
    tokenRefresher: refreshToken,
  });
  const actorStateUnit: SmelterActorStateUnit = createSmelterActorStateUnit({
    bus: httpTransport.actor,
  });

  // Same adapter the SDK wires for its content path; reuses the bus
  // transport's ky instance, token$ auth, and trace propagation. The Smelter
  // requests verbatim mode per read (see fetchEmbeddableText).
  const contentTransport = new HttpContentTransport(httpTransport);
  logger.info('Content transport ready', { mode: 'http' });

  const smelter = new Smelter(
    actorStateUnit.events$,
    vectorStore,
    embeddingProvider,
    contentTransport,
    httpTransport,
    chunkingConfig,
    { burstWindowMs: 50, maxBatchSize: 100, idleTimeoutMs: 200 },
    logger,
  );
  smelter.initialize();

  actorStateUnit.start();
  logger.info('Subscribed to domain events');

  const health = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        eventsProcessed: smelter.eventsProcessed,
        reconcile: smelter.reconcileState,
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  health.listen(healthPort, () => {
    logger.info('Health endpoint ready', { port: healthPort });
  });

  const shutdown = () => {
    logger.info('Shutting down');
    clearInterval(reauthTimer);
    actorStateUnit.dispose();
    httpTransport.dispose();
    smelter.stop();
    health.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Catch-up pass: the live subscription is attached, so anything that
  // changed while this worker was down — or a wiped Qdrant volume — is
  // brought back in sync here. Fatal on failure: a smelter that cannot
  // reconcile is serving an index of unknown completeness. (A restart
  // re-runs it from scratch — reconcile is idempotent.)
  await smelter.reconcile();
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
