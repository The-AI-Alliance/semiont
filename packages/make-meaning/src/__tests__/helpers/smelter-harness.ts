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
import { Observable, Subject } from 'rxjs';
import type { Logger, EventMap, IContentTransport, components } from '@semiont/core';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { BusRequestPrimitive } from '@semiont/core';
import type { SmelterEvent } from '../../smelter-actor-state-unit';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

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
    dimensions: vi.fn().mockReturnValue(4),
    model: vi.fn().mockReturnValue(model),
  };
}

export function makeAnnotation(resourceId: string, annotationId: string, exact: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId,
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

export function annotationEvent(resourceId: string, annotationId: string, exact: string): SmelterEvent {
  return {
    type: 'mark:added',
    resourceId,
    payload: {
      resourceId,
      annotation: makeAnnotation(resourceId, annotationId, exact),
    },
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

export interface ContentEntry {
  text: string;
  mediaType: string;
}

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
        const bytes = new TextEncoder().encode(entry.text);
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
 */
export function createFakeKsBus(
  resources: ResourceDescriptor[],
  annotationsByResource: Map<string, Annotation[]> = new Map(),
): BusRequestPrimitive {
  const channels = new Map<string, Subject<Record<string, unknown>>>();
  const channel = (name: string): Subject<Record<string, unknown>> => {
    let subject = channels.get(name);
    if (!subject) {
      subject = new Subject<Record<string, unknown>>();
      channels.set(name, subject);
    }
    return subject;
  };

  return {
    async emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): Promise<void> {
      const request = payload as Record<string, unknown>;
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
    },
    stream<K extends keyof EventMap>(name: K): Observable<EventMap[K]> {
      return channel(name as string) as unknown as Observable<EventMap[K]>;
    },
  };
}
