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
 * Events arrive over SSE from the gateway; bytes come over HTTP from the
 * ARCHIVIST (SINGLE-KB-MOUNT P4), verbatim — the stored bytes, untouched,
 * because the checksum stamp depends on it (SMELTER-AXIOMS.md S12). Its
 * privileged attachments beyond the bus are the vector store (Qdrant) and
 * the anchored-text mount it owns outright (ANCHORED-TEXT-TO-SMELTER P1).
 *
 * Environment variables:
 *   SEMIONT_WORKER_SECRET      — shared secret; JWT auth with the KS, and
 *                                the bearer this process shows the Archivist
 *   SEMIONT_ANCHORED_TEXT_DIR  — the anchored-text store's mount; no default
 */

import { BehaviorSubject } from 'rxjs';
import { archivistContentReads, createAnchoredTextStore } from '@semiont/content';
import { createSmelterActorStateUnit, type SmelterActorStateUnit } from './smelter-actor-state-unit';
import { Smelter } from './smelter';
import { SMELTER_REPLY_CHANNELS } from './service-channels';
import { HttpTransport } from '@semiont/http-transport';
import { baseUrl as makeBaseUrl, accessToken as makeAccessToken, createTomlConfigLoader, retryWithBackoff, isTransientFetchError, STARTUP_FETCH_RETRY } from '@semiont/core';
import type { AccessToken } from '@semiont/core';
import { createVectorStore, createEmbeddingProvider } from '@semiont/vectors';
import type { ChunkingConfig } from '@semiont/core';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ───────────────────────────────────────────────────────────

const configPath = join(homedir(), '.semiontconfig');
const tomlReader = {
  readIfExists: (p: string): string | null => existsSync(p) ? readFileSync(p, 'utf-8') : null,
};
// Environment resolved by the loader from `[defaults] environment`
// (no project root here — global ~/.semiontconfig only). Was hardcoded 'local',
// which read the wrong section for any non-local KB the container stages.
const envConfig = createTomlConfigLoader(
  tomlReader,
  configPath,
  process.env,
)(null);

const gatewayPublicURL = envConfig.services?.gateway?.publicURL;
if (!gatewayPublicURL) {
  throw new Error('services.gateway.publicURL is required in ~/.semiontconfig');
}
const baseUrl: string = gatewayPublicURL;

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
  //
  // Connection-level failures are retried with backoff: the gateway may be
  // mid-restart or the container network still warming up when this process
  // starts, and orchestration runs it with `--rm` and no restart policy —
  // exiting on the first failed fetch is permanent death. HTTP-level
  // rejections (bad secret) are NOT retried; the gateway is up and said no.
  return retryWithBackoff(
    async () => {
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
    },
    isTransientFetchError,
    STARTUP_FETCH_RETRY,
    ({ attempt, attempts, delayMs, error }) => {
      logger.warn('Gateway unreachable, retrying authentication', {
        attempt,
        attempts,
        retryInMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
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

  const vectorStore = await createVectorStore({
    type: 'qdrant',
    host: qdrantHost,
    port: qdrantPort,
    dimensions: () => embeddingProvider.dimensions(),
  });
  logger.info('Vector store ready', { host: qdrantHost, port: qdrantPort });

  // Tier 3 observability: report index point count. Polled at the
  // metric-collection interval (default 30s).
  registerVectorIndexSizeProvider(() => vectorStore.count());

  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: tokenSubject,
    tokenRefresher: refreshToken,
    // Only the reply channels this process awaits — not the full bridged
    // set, whose global reply fan-out is the worker-OOM failure mode. See
    // SMELTER_AWAITED_OPERATIONS. The domain-event channels are added by
    // the actor state unit's start() below.
    channels: SMELTER_REPLY_CHANNELS,
  });
  const actorStateUnit: SmelterActorStateUnit = createSmelterActorStateUnit({
    bus: httpTransport.actor,
  });

  // Bytes come from the Archivist, not the gateway (SINGLE-KB-MOUNT P4).
  // The gateway's own content routes are a proxy onto this same call, so
  // going through it added a hop and put a process that is meant to stop
  // touching the KB tree on the path to it. Throws here if the address or
  // the worker secret is missing — a boot-time refusal, not a per-resource
  // failure.
  const contentReads = archivistContentReads(envConfig);
  logger.info('Content reads ready', { via: 'archivist' });

  // The anchored-text store, on this process's own mount (ANCHORED-TEXT-TO-SMELTER
  // P1). The Smelter derives these artifacts, so it holds them: no gateway
  // round-trip to reach its own output, and it is the sole writer.
  const anchoredTextDir = process.env.SEMIONT_ANCHORED_TEXT_DIR;
  if (!anchoredTextDir) {
    throw new Error('SEMIONT_ANCHORED_TEXT_DIR is required — the Smelter owns the anchored-text store and has no default for where it lives');
  }
  const anchoredStore = createAnchoredTextStore(anchoredTextDir, logger.child({ component: 'anchored-text-store' }));

  const smelter = new Smelter(
    actorStateUnit.events$,
    actorStateUnit.rebuildAnchors$,
    vectorStore,
    embeddingProvider,
    contentReads,
    anchoredStore,
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
