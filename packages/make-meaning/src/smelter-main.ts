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

import { archivistContentReads, createAnchoredTextStore } from '@semiont/content';
import { SMELTER_MANIFEST, createSmelterActorStateUnit, type SmelterActorStateUnit } from './smelter-actor-state-unit';
import { Smelter } from './smelter';
import { HttpTransport } from '@semiont/http-transport';
import { baseUrl as makeBaseUrl, createTomlConfigLoader, withDeadline } from '@semiont/core';
import { runBootPass } from './boot-pass';
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

/**
 * This process's own account at the issuer. The credential authenticates the
 * PROCESS; the agent DID it buys names the WORK. See `startAgentSession`.
 */
const issuerUrl = envConfig.services?.identity?.issuer;
if (!issuerUrl) {
  throw new Error('services.identity.issuer is required: a sidecar authenticates at the knowledge base\'s issuer');
}
const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are required to authenticate as a service account');
}
const credential = { issuer: issuerUrl, clientId, clientSecret };

const healthPort = 24101;

import { createProcessLogger } from '@semiont/observability/process-logger';
import { startAgentSession } from './agent-session';
import { registerVectorIndexSizeProvider } from '@semiont/observability';
import { STARTUP_CONNECT_TIMEOUT_MS, RESTART_HINT } from './service';
const logger = createProcessLogger('smelter');

// ── Auth ─────────────────────────────────────────────────────────────

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode, registerSupervisorRestartCount } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-smelter' });
  // Supervised, but with no writable /semiont-state: `supervise.sh` keeps its
  // event log in /tmp and exports the resolved path. That is enough for the
  // LIVE count — the container does not exit when the child restarts — and
  // only surviving container teardown would need a mount (F2, declined).
  registerSupervisorRestartCount();

  // The smelter is a Software peer just like an inference agent — it
  // authenticates with its (provider, model) so the bus stamps a typed
  // agent DID onto every event it emits. Identity granularity follows
  // the embedding config; two smelters with different embedding
  // providers run as different agents.
  //
  // The token's lifetime and the refresh cadence derived from it are the
  // gateway's to decide; see `startAgentSession`.
  const session = await startAgentSession({
    baseUrl,
    credential,
    provider: embeddingType,
    model: embeddingModel,
    logger,
  });

  // Bounded (see the archivist's note): an unbounded await on a dependency that
  // is not up hangs the container, and `restart: on-failure` cannot rescue a
  // process that never exits.
  const embeddingProvider = await withDeadline('Embedding provider', STARTUP_CONNECT_TIMEOUT_MS,
    () => createEmbeddingProvider({
      type: embeddingType,
      model: embeddingModel,
      baseURL: embeddingBaseURL,
    }), RESTART_HINT);
  logger.info('Embedding provider ready', { type: embeddingType, model: embeddingModel });

  const vectorStore = await withDeadline('Vector store', STARTUP_CONNECT_TIMEOUT_MS,
    (signal) => createVectorStore({
      signal,
      type: 'qdrant',
      host: qdrantHost,
      port: qdrantPort,
      dimensions: () => embeddingProvider.dimensions(),
    }), RESTART_HINT);
  logger.info('Vector store ready', { host: qdrantHost, port: qdrantPort });

  // Tier 3 observability: report index point count. Polled at the
  // metric-collection interval (default 30s).
  registerVectorIndexSizeProvider(() => vectorStore.count());

  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: session.token$,
    tokenRefresher: session.refresh,
    // The whole manifest at construction — reply channels, the domain-event
    // fold and the command channels — not the reply set plus a later
    // widening. See SMELTER_MANIFEST.
    channels: SMELTER_MANIFEST,
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
    session.stop();
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
  // brought back in sync here.
  //
  // NOT fatal since SIDECAR-BOOT-RESILIENCE P3, for the same reason as the
  // weaver's: an index of unknown completeness is a data condition, and exiting
  // does not complete it. No state sink is passed — `Smelter.reconcile()` already
  // sets `reconcileState` to `{ phase: 'failed' }` before it throws, and that is
  // what `/health` serves.
  await runBootPass('reconcile', () => smelter.reconcile(), logger);
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});