/**
 * Smelter Main — standalone entry point
 *
 * Continuous stream processor that subscribes to domain events via the
 * EventBus gateway, fetches content via HTTP, chunks text, embeds via
 * the configured provider, and writes vectors to Qdrant.
 *
 * Reads configuration from ~/.semiontconfig (TOML) via the canonical
 * `createTomlConfigLoader` from @semiont/core. Authenticates with the
 * KS via shared secret.
 *
 * Environment variables:
 *   SEMIONT_WORKER_SECRET — shared secret for JWT auth with the KS
 */

import { Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { createSmelterActorVM, type SmelterActorVM } from '@semiont/sdk';
import { burstBuffer, createTomlConfigLoader } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import type { VectorStore, EmbeddingProvider, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import { createVectorStore, createEmbeddingProvider, chunkText } from '@semiont/vectors';
import type { ChunkingConfig } from '@semiont/vectors';
import { getExactText, getTargetSelector } from '@semiont/core';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface SmelterEvent {
  type: string;
  resourceId?: string;
  payload: Record<string, unknown>;
}

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

const BURST_WINDOW_MS = 50;
const MAX_BATCH_SIZE = 100;
const IDLE_TIMEOUT_MS = 200;

import { createProcessLogger } from './logger';
const logger = createProcessLogger('smelter');

// ── Auth ─────────────────────────────────────────────────────────────

async function authenticate(): Promise<string> {
  if (!workerSecret) {
    logger.warn('No SEMIONT_WORKER_SECRET set — using empty token');
    return '';
  }

  const response = await fetch(`${baseUrl}/api/tokens/worker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: workerSecret }),
  });

  if (!response.ok) {
    throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
  }

  const { token } = await response.json() as { token: string };
  return token;
}

// ── Content fetching via HTTP ────────────────────────────────────────

let authToken = '';

async function fetchContent(resourceId: string): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/api/resources/${resourceId}`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: 'text/plain',
      },
    });
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}

// ── Event processing ─────────────────────────────────────────────────

let vectorStore: VectorStore;
let embeddingProvider: EmbeddingProvider;
let eventsProcessed = 0;

async function processEvent(event: SmelterEvent): Promise<void> {
  try {
    switch (event.type) {
      case 'yield:created':
        await handleResourceCreated(event);
        break;
      case 'yield:updated':
      case 'yield:representation-added':
        await handleResourceReembed(event);
        break;
      case 'mark:archived':
        await handleResourceArchived(event);
        break;
      case 'mark:added':
        await handleAnnotationAdded(event);
        break;
      case 'mark:removed':
        await handleAnnotationRemoved(event);
        break;
    }
    eventsProcessed++;
  } catch (err) {
    logger.error('Failed to process event', { type: event.type, resourceId: event.resourceId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleResourceCreated(event: SmelterEvent): Promise<void> {
  const rid = event.resourceId;
  if (!rid) return;

  const text = await fetchContent(rid);
  if (!text?.trim()) return;

  const chunks = chunkText(text, chunkingConfig);
  if (chunks.length === 0) return;

  const embeddings = await embeddingProvider.embedBatch(chunks);
  const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
    chunkIndex: i, text: t, embedding: embeddings[i],
  }));

  await vectorStore.upsertResourceVectors(makeResourceId(rid), embeddingChunks);
  logger.info('Indexed resource', { resourceId: rid, chunks: chunks.length });
}

async function handleResourceReembed(event: SmelterEvent): Promise<void> {
  const rid = event.resourceId;
  if (!rid) return;

  const text = await fetchContent(rid);
  if (!text?.trim()) return;

  const chunks = chunkText(text, chunkingConfig);
  if (chunks.length === 0) return;

  const embeddings = await embeddingProvider.embedBatch(chunks);
  const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
    chunkIndex: i, text: t, embedding: embeddings[i],
  }));

  await vectorStore.deleteResourceVectors(makeResourceId(rid));
  await vectorStore.upsertResourceVectors(makeResourceId(rid), embeddingChunks);
  logger.info('Re-embedded resource', { resourceId: rid, chunks: chunks.length });
}

async function handleResourceArchived(event: SmelterEvent): Promise<void> {
  const rid = event.resourceId;
  if (!rid) return;
  await vectorStore.deleteResourceVectors(makeResourceId(rid));
  logger.info('Deleted vectors for archived resource', { resourceId: rid });
}

async function handleAnnotationAdded(event: SmelterEvent): Promise<void> {
  const annotation = event.payload.annotation as Record<string, unknown> | undefined;
  if (!annotation?.id) return;

  const rid = event.resourceId;
  if (!rid) return;

  const selector = getTargetSelector(annotation.target as any);
  const exactText = getExactText(selector);
  if (!exactText?.trim()) return;

  const aid = makeAnnotationId(annotation.id as string);
  const embedding = await embeddingProvider.embed(exactText);

  const payload: AnnotationPayload = {
    annotationId: aid,
    resourceId: makeResourceId(rid),
    motivation: (annotation.motivation as string) ?? '',
    entityTypes: (annotation.entityTypes as string[]) ?? [],
    exactText,
  };
  await vectorStore.upsertAnnotationVector(aid, embedding, payload);
  logger.info('Indexed annotation', { annotationId: String(aid) });
}

async function handleAnnotationRemoved(event: SmelterEvent): Promise<void> {
  const annotationId = event.payload.annotationId as string | undefined;
  if (!annotationId) return;
  const aid = makeAnnotationId(annotationId);
  await vectorStore.deleteAnnotationVector(aid);
  logger.info('Deleted annotation vector', { annotationId });
}

async function processBatch(events: SmelterEvent[]): Promise<void> {
  const type = events[0].type;

  if (type === 'yield:created') {
    await batchResourceCreated(events);
  } else if (type === 'mark:added') {
    await batchAnnotationAdded(events);
  } else {
    for (const event of events) {
      await processEvent(event);
    }
  }
}

async function batchResourceCreated(events: SmelterEvent[]): Promise<void> {
  const resourceData: { rid: ResourceId; chunks: string[] }[] = [];
  const allChunks: string[] = [];

  for (const event of events) {
    const rid = event.resourceId;
    if (!rid) continue;

    const text = await fetchContent(rid);
    if (!text?.trim()) continue;

    const chunks = chunkText(text, chunkingConfig);
    if (chunks.length === 0) continue;

    resourceData.push({ rid: makeResourceId(rid), chunks });
    allChunks.push(...chunks);
  }

  if (allChunks.length === 0) return;

  const allEmbeddings = await embeddingProvider.embedBatch(allChunks);

  let offset = 0;
  for (const { rid, chunks } of resourceData) {
    const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
      chunkIndex: i, text: t, embedding: allEmbeddings[offset + i],
    }));
    await vectorStore.upsertResourceVectors(rid, embeddingChunks);
    logger.info('Batch-indexed resource', { resourceId: String(rid), chunks: chunks.length });
    offset += chunks.length;
  }

  eventsProcessed += events.length;
}

async function batchAnnotationAdded(events: SmelterEvent[]): Promise<void> {
  const annotationData: {
    rid: ResourceId;
    aid: ReturnType<typeof makeAnnotationId>;
    exactText: string;
    motivation: string;
    entityTypes: string[];
  }[] = [];

  for (const event of events) {
    const annotation = event.payload.annotation as Record<string, unknown> | undefined;
    if (!annotation?.id) continue;

    const rid = event.resourceId;
    if (!rid) continue;

    const selector = getTargetSelector(annotation.target as any);
    const exactText = getExactText(selector);
    if (!exactText?.trim()) continue;

    annotationData.push({
      rid: makeResourceId(rid),
      aid: makeAnnotationId(annotation.id as string),
      exactText,
      motivation: (annotation.motivation as string) ?? '',
      entityTypes: (annotation.entityTypes as string[]) ?? [],
    });
  }

  if (annotationData.length === 0) return;

  const allEmbeddings = await embeddingProvider.embedBatch(
    annotationData.map((a) => a.exactText),
  );

  for (let i = 0; i < annotationData.length; i++) {
    const { rid, aid, exactText, motivation, entityTypes } = annotationData[i];
    const payload: AnnotationPayload = {
      annotationId: aid, resourceId: rid, motivation, entityTypes, exactText,
    };
    await vectorStore.upsertAnnotationVector(aid, allEmbeddings[i], payload);
    logger.info('Batch-indexed annotation', { annotationId: String(aid) });
  }

  eventsProcessed += events.length;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('Authenticating', { baseUrl });
  authToken = await authenticate();
  logger.info('Authenticated');

  embeddingProvider = await createEmbeddingProvider({
    type: embeddingType,
    model: embeddingModel,
    baseURL: embeddingBaseURL,
  });
  logger.info('Embedding provider ready', { type: embeddingType, model: embeddingModel });

  const dimensions = embeddingProvider.dimensions();
  vectorStore = await createVectorStore({
    type: 'qdrant',
    host: qdrantHost,
    port: qdrantPort,
    dimensions,
  });
  logger.info('Vector store ready', { host: qdrantHost, port: qdrantPort, dimensions });

  const actorVM: SmelterActorVM = createSmelterActorVM({
    baseUrl,
    token: authToken,
  });

  const eventSubject = new Subject<SmelterEvent>();

  const pipelineSubscription: Subscription = eventSubject.pipe(
    groupBy((e) => e.resourceId ?? '__unknown__'),
    mergeMap((group) =>
      group.pipe(
        burstBuffer<SmelterEvent>({
          burstWindowMs: BURST_WINDOW_MS,
          maxBatchSize: MAX_BATCH_SIZE,
          idleTimeoutMs: IDLE_TIMEOUT_MS,
        }),
        concatMap((eventOrBatch: SmelterEvent | SmelterEvent[]) => {
          if (Array.isArray(eventOrBatch)) {
            return from(processBatch(eventOrBatch));
          }
          return from(processEvent(eventOrBatch));
        }),
      ),
    ),
  ).subscribe({
    error: (err) => logger.error('Pipeline error', { error: err instanceof Error ? err.message : String(err) }),
  });

  actorVM.events$.subscribe((event) => {
    logger.debug('Bus event received', { type: event.type, resourceId: event.resourceId });
    eventSubject.next(event);
  });

  actorVM.start();
  logger.info('Subscribed to domain events');

  const health = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', eventsProcessed }));
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
    actorVM.dispose();
    pipelineSubscription.unsubscribe();
    eventSubject.complete();
    health.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
