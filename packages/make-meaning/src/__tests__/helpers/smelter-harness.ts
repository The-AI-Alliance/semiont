/**
 * Shared Smelter test harness.
 *
 * Used by `smelter.test.ts` (example-based behaviors) and
 * `smelter-axioms.test.ts` (fast-check properties — see
 * `.plans/SMELTER-AXIOMS.md`). Provides:
 *   - a deterministic mock EmbeddingProvider (embedding is a pure function
 *     of text, so reference models stay trivial)
 *   - W3C annotation / SmelterEvent / ResourceDescriptor builders
 *   - an in-memory IContentTransport mirroring the production transport's
 *     semantics (unknown resources throw rather than returning null)
 *   - a fake KS bus serving the browse RPC channels with the same
 *     correlationId request/reply protocol the Browser actor uses
 */

import { vi } from 'vitest';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import type { Annotation, ExtractionOutcome, ConnectionState, Logger, EventMap, IContentTransport, components } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId, userId as makeUserId } from '@semiont/core';
import type { AnchoredTextStore } from '@semiont/content';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { BusRequestPrimitive } from '@semiont/core';
import type { WorkerBus } from '@semiont/sdk';
import type { SmelterChannel } from '../../smelter-actor-state-unit';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

export function deterministicEmbed(text: string): number[] {
  const vec = new Array(4);
  for (let i = 0; i < 4; i++) {
    vec[i] = Math.sin((text.charCodeAt(i % text.length) || 0) + i);
  }
  return vec;
}

export function createMockEmbeddingProvider(model = 'mock-model'): EmbeddingProvider {
  return {
    embed: vi.fn().mockImplementation(async (text: string) => deterministicEmbed(text)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(deterministicEmbed)),
    dimensions: vi.fn().mockResolvedValue(4),
    model: vi.fn().mockReturnValue(model),
  };
}

export function makeAnnotation(resourceId: string, annotationId: string, exact: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: makeAnnotationId(annotationId),
    motivation: 'highlighting',
    target: {
      source: resourceId,
      selector: {
        type: 'TextQuoteSelector',
        exact,
      },
    },
    created: new Date().toISOString(),
  };
}

// ── Domain events, exactly as the bus delivers them ──────────────────────────
//
// A full `StoredEvent`: the envelope below, with the body under `.payload`.
// Each builder is typed against its own `EventMap` entry, so a fixture cannot
// drift from the wire. The flat `{ type, resourceId, payload }` literals these
// replace hid a live bug: no type held them to the real shape, and the Smelter
// read `mark:removed` one level too shallow for as long as they stood.

let sequence = 0;

function envelope(resourceId: string) {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    timestamp: new Date(0).toISOString(),
    resourceId: makeResourceId(resourceId),
    userId: makeUserId('did:web:test.example:users:harness'),
    version: 1,
    metadata: { sequenceNumber: sequence },
  };
}

export const yieldCreated = (resourceId: string): EventMap['yield:created'] => ({
  ...envelope(resourceId),
  type: 'yield:created',
  payload: { name: resourceId, format: 'text/plain', contentChecksum: 'harness' },
});

export const yieldUpdated = (resourceId: string): EventMap['yield:updated'] => ({
  ...envelope(resourceId),
  type: 'yield:updated',
  payload: { contentChecksum: 'harness' },
});

export const yieldRepresentationAdded = (resourceId: string): EventMap['yield:representation-added'] => ({
  ...envelope(resourceId),
  type: 'yield:representation-added',
  payload: { representation: { mediaType: 'text/plain' } },
});

export const markArchived = (resourceId: string): EventMap['mark:archived'] => ({
  ...envelope(resourceId),
  type: 'mark:archived',
  payload: {},
});

export const markUnarchived = (resourceId: string): EventMap['mark:unarchived'] => ({
  ...envelope(resourceId),
  type: 'mark:unarchived',
  payload: {},
});

export function annotationEvent(resourceId: string, annotationId: string, exact: string): EventMap['mark:added'] {
  return {
    ...envelope(resourceId),
    type: 'mark:added',
    payload: { annotation: makeAnnotation(resourceId, annotationId, exact) },
  };
}

export const markRemoved = (resourceId: string, annotationId: string): EventMap['mark:removed'] => ({
  ...envelope(resourceId),
  type: 'mark:removed',
  payload: { annotationId: makeAnnotationId(annotationId) },
});

export const markEntityTagAdded = (resourceId: string, entityType: string): EventMap['mark:entity-tag-added'] => ({
  ...envelope(resourceId),
  type: 'mark:entity-tag-added',
  payload: { entityType },
});

export const markEntityTagRemoved = (resourceId: string, entityType: string): EventMap['mark:entity-tag-removed'] => ({
  ...envelope(resourceId),
  type: 'mark:entity-tag-removed',
  payload: { entityType },
});

/**
 * A `WorkerBus` whose domain channels are fed by `push` — typed per channel,
 * so a test can only put on the bus what the bus actually carries.
 */
export function createFakeWorkerBus() {
  const streams = new Map<string, Subject<unknown>>();
  const channels = new Set<string>();
  const stream = (channel: string): Subject<unknown> => {
    let s = streams.get(channel);
    if (!s) {
      s = new Subject<unknown>();
      streams.set(channel, s);
    }
    return s;
  };
  const bus: WorkerBus = {
    addChannels: vi.fn((cs: readonly string[]) => {
      cs.forEach((c) => channels.add(c));
    }),
    // The one unavoidable cast: `WorkerBus.on$<T>(channel: string)` takes a
    // free `T` it cannot derive from the channel, so no implementation can
    // produce one without asserting it. Typing `on$` by channel removes it.
    on$: <T,>(channel: string) => stream(channel).asObservable() as Observable<T>,
    state$: new BehaviorSubject<ConnectionState>('open'),
    emit: vi.fn(async () => -1),
  };
  return {
    bus,
    channels,
    push: <K extends SmelterChannel>(channel: K, event: EventMap[K]) => stream(channel).next(event),
  };
}

export function resourceDescriptor(id: string, mediaType = 'text/plain', checksum?: string, entityTypes: string[] = []): ResourceDescriptor {
  return {
    '@context': 'https://schema.org',
    '@id': id,
    name: id,
    ...(entityTypes.length ? { entityTypes } : {}),
    representations: [{ mediaType, storageUri: `file://${id}.txt`, ...(checksum ? { checksum } : {}) }],
  };
}

export type ContentEntry =
  | { text: string; mediaType: string }
  | { bytes: Uint8Array; mediaType: string };

/**
 * IContentTransport over a read function with per-resource media types,
 * mirroring HttpContentTransport semantics: unknown resources throw.
 * Bytes are captured at call time; `wrap` (e.g. a fast-check scheduler's
 * `schedule`) controls when the read resolves — the interleaving hook for
 * S1/S2. A read returning `'fail'` throws — the injected-failure hook for S9a.
 */
export function createContentTransport(opts: {
  read: (rid: string) => ContentEntry | 'fail' | undefined;
  wrap?: <T>(p: Promise<T>, label: string) => Promise<T>;
}): IContentTransport {
  return {
    async putBinary(): Promise<never> {
      throw new Error('not supported');
    },
    async getBinary(resourceId) {
      const rid = String(resourceId);
      const make = async (): Promise<{ data: ArrayBuffer; contentType: string }> => {
        const entry = opts.read(rid);
        if (entry === 'fail') throw new Error(`injected read failure: ${rid}`);
        if (!entry) throw new Error(`Resource not found: ${rid}`);
        const bytes = 'bytes' in entry ? entry.bytes : new TextEncoder().encode(entry.text);
        const data = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(data).set(bytes);
        return { data, contentType: entry.mediaType };
      };
      return opts.wrap ? opts.wrap(make(), `read:${rid}`) : make();
    },
    async getBinaryStream(): Promise<never> {
      throw new Error('not used in tests');
    },
    async getResourceGraph(): Promise<never> {
      throw new Error('not used in tests');
    },
    dispose() {},
  };
}

/** Text-only convenience over `createContentTransport` (legacy signature). */
export function createMockContentTransport(
  contentByResourceId: Map<string, string>,
  contentType = 'text/plain',
): IContentTransport {
  return createContentTransport({
    read: (rid) => {
      const text = contentByResourceId.get(rid);
      return text === undefined ? undefined : { text, mediaType: contentType };
    },
  });
}

/**
 * BusRequestPrimitive serving the browse RPC channels from a fake catalog,
 * with the same correlationId request/reply protocol the Browser actor uses.
 * Every emit is also recorded in `emitted` (browse requests included —
 * filter by channel in assertions), so tests can observe the Smelter's
 * outbound signals (`smelt:settled`).
 */
/**
 * An in-memory `AnchoredTextStore` — the Smelter's own store, which it now
 * holds directly rather than reaching through the content transport
 * (ANCHORED-TEXT-TO-SMELTER P1).
 *
 * `write` REJECTS rather than swallowing, matching the real store's contract
 * (a write that returns has written). Tests that want the best-effort seam's
 * behaviour catch at their own call site, exactly as `pdf-extractor` does.
 * Pass a shared `entries` map to assert on what was published.
 */
export function memoryAnchoredStore(
  entries: Map<string, ExtractionOutcome> = new Map(),
): AnchoredTextStore {
  return {
    async read(key) {
      return entries.get(key) ?? null;
    },
    async write(key, outcome) {
      entries.set(key, outcome);
    },
    async list() {
      return [...entries.keys()];
    },
  };
}

export function createFakeKsBus(
  resources: ResourceDescriptor[],
  annotationsByResource: Map<string, Annotation[]> = new Map(),
): BusRequestPrimitive & { emitted: Array<{ channel: string; payload: Record<string, unknown> }> } {
  const channels = new Map<string, Subject<Record<string, unknown>>>();
  const channel = (name: string): Subject<Record<string, unknown>> => {
    let subject = channels.get(name);
    if (!subject) {
      subject = new Subject<Record<string, unknown>>();
      channels.set(name, subject);
    }
    return subject;
  };
  const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];

  return {
    emitted,
    // In-process fake — replies are queued on emit, so 'open' is the truth.
    state$: new BehaviorSubject<ConnectionState>('open'),
    async emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): Promise<number> {
      const request = payload as Record<string, unknown>;
      emitted.push({ channel: name as string, payload: request });
      if (name === 'browse:resources-requested') {
        const offset = (request.offset as number | undefined) ?? 0;
        const limit = (request.limit as number | undefined) ?? 50;
        queueMicrotask(() => channel('browse:resources-result').next({
          correlationId: request.correlationId,
          response: {
            resources: resources.slice(offset, offset + limit),
            total: resources.length,
            offset,
            limit,
            matchKind: 'lexical' as const,
          },
        }));
      } else if (name === 'browse:resource-requested') {
        const resource = resources.find((r) => r['@id'] === request.resourceId);
        queueMicrotask(() => channel('browse:resource-result').next({
          correlationId: request.correlationId,
          response: { resource },
        }));
      } else if (name === 'browse:annotations-requested') {
        const annotations = annotationsByResource.get(request.resourceId as string) ?? [];
        queueMicrotask(() => channel('browse:annotations-result').next({
          correlationId: request.correlationId,
          response: { annotations, total: annotations.length },
        }));
      }
      return 1;
    },
    stream<K extends keyof EventMap>(name: K): Observable<EventMap[K]> {
      return channel(name as string) as unknown as Observable<EventMap[K]>;
    },
  };
}

/**
 * Serve the embedding provider's dimension-discovery probe — startMakeMeaning's
 * only embedding network call (MANDATORY-EMBEDDING P3) — so service startup is
 * hermetic. A plain function, not a vi.fn(): clearAllMocks must not strip it.
 */
export function stubEmbeddingProbeFetch(): void {
  vi.stubGlobal('fetch', async () => new Response(
    JSON.stringify({ embeddings: [[0.1, 0.2, 0.3, 0.4]] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
}
