/**
 * `@semiont/sdk/testing` — the SDK's contract double, exported where
 * consumers already look.
 *
 * One scriptable, REAL-pathway test client: `createTestClient` wires a real
 * `SemiontClient` — real `createCache`, real `Bus.request`, real namespaces —
 * over a `FaultyTransport` (re-exported below; its home stays
 * `@semiont/core/testing`). Script the transport, observe through the
 * client. `createTestSession` wraps the same stack in a real
 * `SemiontSession` for state-unit factories, which take a session.
 *
 * Why this exists: a hand-rolled mock encodes its author's model of the
 * contract instead of the contract, so a wrong belief about the SDK passes
 * inside green tests — a fixture whose `state$` satisfies the TYPE but not
 * the contract, for one.
 * Tests whose subject is consumer behavior should start here; bespoke
 * fixtures are for testing the transport contract itself.
 */

import { BehaviorSubject } from 'rxjs';
import type {
  AccessToken,
  AnchoredTextAnswer,
  IGatewayOperations,
  IContentTransport,
  PutBinaryOptions,
  PutBinaryRequest,
  ResourceId,
  components,
} from '@semiont/core';
import type { SessionStorage } from './session/session-storage';
import { resourceId as makeResourceId } from '@semiont/core';
import { FaultyTransport, type FaultyTransportConfig } from '@semiont/core/testing';
import { SemiontClient } from './client';
import { SemiontSession } from './session/semiont-session';
import type { KbTarget } from '@semiont/core';
import { httpKb } from './session/knowledge-base';
import { InMemorySessionStorage } from './session/session-storage';

type GetResourceResponse = components['schemas']['GetResourceResponse'];
type GetAnnotationsResponse = components['schemas']['GetAnnotationsResponse'];

// The transport double's scripting surface, so a consumer test imports ONE
// module. `FaultyTransport`'s home remains `@semiont/core/testing` — this is
// the consumer-facing barrel, not a second home.
export {
  FaultyTransport,
  refuseUnscriptedOperation,
  retryKeyOf,
  type FaultAction,
  type FaultyTransportConfig,
  type RequestLogEntry,
} from '@semiont/core/testing';

/**
 * Minimal in-memory `IContentTransport`. Stores what `putBinary` receives;
 * `getBinary` throws on unknown ids the way a real transport 404s, so a
 * test that forgets to seed content fails loudly instead of returning
 * fabricated bytes. `getAnchoredText` and `getAnnotations` throw for every
 * id: nothing here derives text or records annotations, and an answer is a
 * test's to give. A test that needs one passes its own `content`.
 */
export function inMemoryContent(): IContentTransport {
  const store = new Map<string, { data: ArrayBuffer; contentType: string }>();
  let seq = 0;
  const toBuffer = (file: File | Buffer): Promise<ArrayBuffer> =>
    file instanceof Uint8Array
      ? Promise.resolve(
          file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
        )
      : file.arrayBuffer();

  return {
    async putBinary(
      request: PutBinaryRequest,
      _options?: PutBinaryOptions,
    ): Promise<{ resourceId: ResourceId }> {
      const rId = makeResourceId(`test-content-${++seq}`);
      const data = await toBuffer(request.file);
      store.set(rId as string, {
        data,
        contentType: String(request.format),
      });
      return { resourceId: rId };
    },
    async getBinary(rId: ResourceId): Promise<{ data: ArrayBuffer; contentType: string }> {
      const hit = store.get(rId as string);
      if (!hit) throw new Error(`inMemoryContent: no content stored for ${String(rId)}`);
      return hit;
    },
    async getBinaryStream(
      rId: ResourceId,
    ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
      const { data, contentType } = await this.getBinary(rId);
      return {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(data));
            controller.close();
          },
        }),
        contentType,
      };
    },
    async getResourceGraph(rId: ResourceId): Promise<GetResourceResponse> {
      return {
        resource: { '@context': 'https://semiont.dev/context/v1', '@id': rId, name: String(rId), representations: [] },
        annotations: [],
      };
    },
    async getAnnotations(rId: ResourceId): Promise<GetAnnotationsResponse> {
      throw new Error(`inMemoryContent: no annotations for ${String(rId)}`);
    },
    async getAnchoredText(rId: ResourceId): Promise<AnchoredTextAnswer> {
      throw new Error(`inMemoryContent: no anchored text for ${String(rId)}`);
    },
    dispose(): void {
      store.clear();
    },
  };
}

export interface TestClientOptions {
  /** FaultyTransport scripting: fault schedule, scope model, `makeResponse`. */
  transport?: FaultyTransportConfig;
  /**
   * Gateway operations for the `auth`/`system` namespaces. Omitted = both are
   * `undefined` (a transport-only client). Pass `stubGateway()` when a unit
   * under test touches
   * `client.auth` and the test scripts it via `AuthNamespace.prototype`
   * spies (the AuthShell precedent).
   */
  gateway?: IGatewayOperations;
  /**
   * `Bus.request` timeout for the browse caches — the deterministic-time
   * knob. Pass something small (e.g. 40) when a test drives B14/B15
   * through timeouts; irrelevant for `reject-emit` faults.
   */
  busTimeoutMs?: number;
  /** Replace the in-memory content transport (e.g. to pre-seed bytes). */
  content?: IContentTransport;
  /** B17 persistence, for rehydration tests. Omitted = in-memory caches. */
  cachePersistence?: { storage: SessionStorage; keyPrefix: string };
}

/**
 * A COMPLETE `IGatewayOperations` whose every method rejects loudly with its
 * own name — so a unit that touches an op the test didn't script fails with
 * "not scripted: <op>" instead of a fabricated success. Script behavior via
 * `AuthNamespace.prototype` / `SystemNamespace.prototype` spies, or spread
 * overrides over this stub. tsc enforces completeness: a new gateway op is a
 * compile error HERE, not a silent gap.
 */
export function stubGateway(): IGatewayOperations {
  const notScripted = (name: string) => () =>
    Promise.reject(new Error(`stubGateway: not scripted: ${name}`));
  return {
    getCurrentUser: notScripted('getCurrentUser'),
    getMediaToken: notScripted('getMediaToken'),
    getProtectedResourceMetadata: notScripted('getProtectedResourceMetadata'),
    healthCheck: notScripted('healthCheck'),
    getStatus: notScripted('getStatus'),
  };
}

/**
 * A real `SemiontClient` over a scriptable `FaultyTransport`.
 *
 * The returned `transport` IS the `FaultyTransport` instance — script faults
 * via its config, drive connection state via `transport.state$.next(...)`,
 * and account requests via `transport.requestLog`.
 */
export function createTestClient(options: TestClientOptions = {}): {
  client: SemiontClient;
  transport: FaultyTransport;
} {
  const transport = new FaultyTransport(options.transport);
  const client = new SemiontClient(transport, options.content ?? inMemoryContent(), options.gateway, {
    ...(options.busTimeoutMs !== undefined ? { busTimeoutMs: options.busTimeoutMs } : {}),
    ...(options.cachePersistence ? { cachePersistence: options.cachePersistence } : {}),
  });
  return { client, transport };
}

export interface TestSessionOptions extends TestClientOptions {
  /** Override the default test KB target (id 'test-kb'). */
  kb?: KbTarget;
}

/**
 * A real `SemiontSession` over the same scriptable stack — for testing
 * state-unit factories, which take a session.
 * No token is seeded and no
 * `validate`/`refresh` callbacks are wired, so `session.ready` settles
 * immediately; tests that need an authenticated shape push into `token$`.
 * The caller ends the session and then the client: the session only uses it.
 */
export function createTestSession(options: TestSessionOptions = {}): {
  session: SemiontSession;
  client: SemiontClient;
  transport: FaultyTransport;
  storage: InMemorySessionStorage;
  token$: BehaviorSubject<AccessToken | null>;
} {
  const { client, transport } = createTestClient(options);
  const storage = new InMemorySessionStorage();
  const token$ = new BehaviorSubject<AccessToken | null>(null);
  const kb =
    options.kb ??
    httpKb({
      id: 'test-kb',
      label: 'Test KB',
      host: 'localhost',
      port: 4000,
      protocol: 'http',
    });
  const session = new SemiontSession({ kb, storage, client, token$ });
  return { session, client, transport, storage, token$ };
}
