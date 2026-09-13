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
import { BehaviorSubject, Observable } from 'rxjs';
import type { Annotation, ExtractionOutcome, ConnectionState, Logger, EventMap, IContentTransport, ResourceDescriptor as CoreResourceDescriptor } from '@semiont/core';
import { EventBus, annotationId as makeAnnotationId, resourceId as makeResourceId, userId as makeUserId } from '@semiont/core';
import type { AnchoredTextStore } from '@semiont/content';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { BusRequestPrimitive } from '@semiont/core';
import type { WorkerBus } from '@semiont/sdk';
import type { SmelterChannel } from '../../smelter-actor-state-unit';

// Core's ResourceDescriptor, not the raw generated one. They differ: core
// derives `RawResourceDescriptor & { '@id': ResourceId }`, and the browse
// reply channels carry the branded form. Aliasing the raw type here meant the
// fake produced descriptors the gateway never sends — invisible while the
// fake cast its way past the channel's type.
type ResourceDescriptor = CoreResourceDescriptor;

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
  // A real `EventBus` rather than a `Map<string, Subject<unknown>>`: core's
  // bus is already typed per channel, so the fake needs no cast and is truer
  // to what production hands the state unit. The map version forced the one
  // cast this comment used to apologise for.
  const eventBus = new EventBus();
  const channels = new Set<keyof EventMap>();
  const bus: WorkerBus = {
    addChannels: vi.fn((cs: readonly (keyof EventMap)[]) => {
      cs.forEach((c) => channels.add(c));
    }),
    stream: <K extends keyof EventMap>(channel: K) => eventBus.get(channel).asObservable(),
    state$: new BehaviorSubject<ConnectionState>('open'),
    emit: vi.fn(async () => -1),
  };
  return {
    bus,
    channels,
    push: <K extends SmelterChannel>(channel: K, event: EventMap[K]) =>
      eventBus.get(channel).next(event),
  };
}

export function resourceDescriptor(id: string, mediaType = 'text/plain', checksum?: string, entityTypes: string[] = []): ResourceDescriptor {
  return {
    '@context': 'https://schema.org',
    '@id': makeResourceId(id),
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

/**
 * A `BusRequestPrimitive` that answers the browse reads the Smelter makes.
 *
 * Over a real `EventBus`, not a `Map<string, Subject<Record<string, unknown>>>`.
 * The map version was weaker than the interface it faked: `BusRequestPrimitive`
 * has been channel-typed all along, and the fake cast its way out of that with
 * `channel(name as string) as unknown as Observable<EventMap[K]>` — so its
 * canned replies could drift from the spec with nothing to say so, which is
 * exactly how `job:queued`'s consumer lost `userId` for months.
 */
/**
 * One emit, with its channel and payload still paired. A plain
 * `{ channel: keyof EventMap; payload: <union> }` pairs every channel with
 * every payload, so `.payload.resourceId` would not typecheck even for an
 * emit we know the channel of.
 */
export type Emitted = { [K in keyof EventMap]: { channel: K; payload: EventMap[K] } }[keyof EventMap];

export function createFakeKsBus(
  resources: ResourceDescriptor[],
  annotationsByResource: Map<string, Annotation[]> = new Map(),
): BusRequestPrimitive & { emitted: readonly Emitted[] } {
  const eventBus = new EventBus();
  const emitted: Emitted[] = [];

  return {
    emitted,
    // In-process fake — replies are queued on emit, so 'open' is the truth.
    state$: new BehaviorSubject<ConnectionState>('open'),
    async emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): Promise<number> {
      // The one assertion, and it buys every narrowing below. TypeScript
      // correlates `channel` with `payload` on READ but not on WRITE through a
      // type parameter: while `K` is unresolved it will not accept
      // `{ channel: K; payload: EventMap[K] }` as a member of the union. The
      // pair is correct by construction — it is this call's own arguments.
      const request = { channel: name, payload } as Emitted;
      emitted.push(request);

      // `request.channel` narrows `request.payload`, so every field read below
      // is checked against the registry instead of asserted off a
      // `Record<string, unknown>`. The replies are checked too: they go onto a
      // typed `EventBus`, so a canned response that is not the spec's shape is
      // a compile error here rather than a passing test.
      if (request.channel === 'browse:resources-requested') {
        const { correlationId, offset = 0, limit = 50 } = request.payload;
        queueMicrotask(() => eventBus.get('browse:resources-result').next({
          correlationId,
          response: {
            resources: resources.slice(offset, offset + limit),
            total: resources.length,
            offset,
            limit,
            matchKind: 'lexical' as const,
          },
        }));
      } else if (request.channel === 'browse:resource-requested') {
        const { correlationId, resourceId } = request.payload;
        const resource = resources.find((r) => r['@id'] === resourceId);
        // Every id resolves: known ones from `resources`, unknown ones to a
        // synthesized descriptor. That is the policy the old fake already
        // had — it never failed a lookup — but it expressed "not found" by
        // replying `{ resource: undefined }`, a shape no gateway sends and
        // only a cast allowed. Suites here drive the Smelter with ids they
        // never registered because the resource read is not what they test;
        // failing those lookups would test something else.
        const found = resource ?? resourceDescriptor(resourceId);
        // The reply carries annotations and entityReferences too — another
        // thing the cast hid, since the fake sent `{ resource }` alone.
        const anns = annotationsByResource.get(resourceId) ?? [];
        queueMicrotask(() => eventBus.get('browse:resource-result').next({
          correlationId,
          response: { resource: found, annotations: anns, entityReferences: [] },
        }));
      } else if (request.channel === 'browse:annotations-requested') {
        const { correlationId, resourceId } = request.payload;
        const annotations = annotationsByResource.get(resourceId) ?? [];
        queueMicrotask(() => eventBus.get('browse:annotations-result').next({
          correlationId,
          response: { annotations, total: annotations.length },
        }));
      }
      return 1;
    },
    stream<K extends keyof EventMap>(name: K): Observable<EventMap[K]> {
      return eventBus.get(name).asObservable();
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
