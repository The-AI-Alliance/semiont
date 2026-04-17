/**
 * Smelter Main — standalone entry point
 *
 * Continuous stream processor that subscribes to domain events via the
 * EventBus gateway, fetches content via HTTP, chunks text, embeds via
 * the configured provider, and writes vectors to Qdrant.
 *
 * Reads configuration from ~/.semiontconfig (TOML).
 * Authenticates with the KS via shared secret.
 *
 * Environment variables:
 *   SEMIONT_WORKER_SECRET — shared secret for JWT auth with the KS
 */

import { Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { createSmelterActorVM, type SmelterActorVM } from '@semiont/api-client';
import { burstBuffer } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import type { VectorStore, EmbeddingProvider, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import { createVectorStore, createEmbeddingProvider, chunkText } from '@semiont/vectors';
import type { ChunkingConfig } from '@semiont/vectors';
import { getExactText, getTargetSelector } from '@semiont/api-client';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface SmelterEvent {
  type: string;
  resourceId?: string;
  payload: Record<string, unknown>;
}

// ── Config ───────────────────────────────────────────────────────────

function readSemiontConfig(): Record<string, string> {
  const configPath = join(homedir(), '.semiontconfig');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const result: Record<string, string> = {};
    let currentSection = '';
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      const sectionMatch = trimmed.match(/^\[(.+)]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }
      const kvMatch = trimmed.match(/^(\w+)\s*=\s*"?([^"]*)"?$/);
      if (kvMatch) {
        const key = currentSection ? `${currentSection}.${kvMatch[1]}` : kvMatch[1];
        let value = kvMatch[2];
        value = value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

const config = readSemiontConfig();
const env = config['defaults.environment'] || 'local';
const get = (key: string): string => config[`environments.${env}.${key}`] ?? '';

const baseUrl = get('backend.publicURL') || 'http://localhost:4000';
const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';
const healthPort = Number(get('smelter.healthPort') || '9091');

const embeddingType = (get('embedding.type') || 'ollama') as 'ollama' | 'voyage';
const embeddingModel = get('embedding.model') || 'nomic-embed-text';
const embeddingBaseURL = get(`embedding.baseURL`) || 'http://localhost:11434';

const qdrantHost = get('vectors.host') || 'localhost';
const qdrantPort = Number(get('vectors.port') || '6333');

const chunkSize = Number(get('embedding.chunking.chunkSize') || '512');
const overlap = Number(get('embedding.chunking.overlap') || '64');
const chunkingConfig: ChunkingConfig = { chunkSize, overlap };

const BURST_WINDOW_MS = 50;
const MAX_BATCH_SIZE = 100;
const IDLE_TIMEOUT_MS = 200;

// ── Auth ─────────────────────────────────────────────────────────────

async function authenticate(): Promise<string> {
  if (!workerSecret) {
    console.warn('[smelter] No SEMIONT_WORKER_SECRET set — using empty token');
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
    const response = await fetch(`${baseUrl}/api/resources/${resourceId}/representation`, {
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
    console.error(`[smelter] Failed to process ${event.type}`, err);
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
  console.log(`[smelter] Indexed resource ${rid} (${chunks.length} chunks)`);
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
  console.log(`[smelter] Re-embedded resource ${rid} (${chunks.length} chunks)`);
}

async function handleResourceArchived(event: SmelterEvent): Promise<void> {
  const rid = event.resourceId;
  if (!rid) return;
  await vectorStore.deleteResourceVectors(makeResourceId(rid));
  console.log(`[smelter] Deleted vectors for archived resource ${rid}`);
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
  console.log(`[smelter] Indexed annotation ${String(aid)}`);
}

async function handleAnnotationRemoved(event: SmelterEvent): Promise<void> {
  const annotationId = event.payload.annotationId as string | undefined;
  if (!annotationId) return;
  const aid = makeAnnotationId(annotationId);
  await vectorStore.deleteAnnotationVector(aid);
  console.log(`[smelter] Deleted annotation vector ${annotationId}`);
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
    console.log(`[smelter] Batch-indexed resource ${String(rid)} (${chunks.length} chunks)`);
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
    console.log(`[smelter] Batch-indexed annotation ${String(aid)}`);
  }

  eventsProcessed += events.length;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`[smelter] Authenticating with ${baseUrl}...`);
  authToken = await authenticate();
  console.log('[smelter] Authenticated');

  embeddingProvider = await createEmbeddingProvider({
    type: embeddingType,
    model: embeddingModel,
    baseURL: embeddingBaseURL,
  });
  console.log(`[smelter] Embedding: ${embeddingType} ${embeddingModel}`);

  const dimensions = embeddingProvider.dimensions();
  vectorStore = await createVectorStore({
    type: 'qdrant',
    host: qdrantHost,
    port: qdrantPort,
    dimensions,
  });
  console.log(`[smelter] Qdrant: ${qdrantHost}:${qdrantPort} (${dimensions}d)`);

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
    error: (err) => console.error('[smelter] Pipeline error:', err),
  });

  actorVM.events$.subscribe((event) => {
    eventSubject.next(event);
  });

  actorVM.start();
  console.log('[smelter] Subscribed to domain events');

  // Health server
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
    console.log(`[smelter] Health endpoint on http://localhost:${healthPort}/health`);
  });

  const shutdown = () => {
    console.log('[smelter] Shutting down...');
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
  console.error('[smelter] Fatal:', error);
  process.exit(1);
});
