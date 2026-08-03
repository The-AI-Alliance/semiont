/**
 * `@semiont/sdk/testing` — the SDK's contract double, exported where
 * consumers already look (.plans/SDK-TESTING-DOUBLE.md, drawing down
 * SDK-DEBT M1).
 *
 * One scriptable, REAL-pathway test client: `createTestClient` wires a real
 * `SemiontClient` — real `createCache`, real `busRequest`, real namespaces —
 * over a `FaultyTransport` (re-exported below; its home stays
 * `@semiont/core/testing`). Script the transport, observe through the
 * client. `createTestSession` wraps the same stack in a real
 * `SemiontSession` for state-unit factories, which take a session
 * (.plans/SESSION-TYPED-FACTORIES.md D1).
 *
 * Why this exists: twice in one week a wrong belief about the SDK shipped
 * inside green tests, because hand-rolled mocks encoded the author's model
 * of the contract instead of the contract (SDK-DEBT M1); PR #1113 then
 * found ~20 fixtures whose `state$` satisfied the TYPE but not the contract.
 * Tests whose subject is consumer behavior should start here; bespoke
 * fixtures are for testing the transport contract itself.
 */

import { BehaviorSubject, throwError } from 'rxjs';
import type {
  AccessToken,
  ExtractionOutcome,
  IBackendOperations,
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
import { httpKb, type KbTarget } from './session/knowledge-base';
import { InMemorySessionStorage } from './session/session-storage';

type GetResourceResponse = components['schemas']['GetResourceResponse'];

// The transport double's scripting surface, so a consumer test imports ONE
// module. `FaultyTransport`'s home remains `@semiont/core/testing` — this is
// the consumer-facing barrel, not a second home.
export {
  FaultyTransport,
  retryKeyOf,
  type FaultAction,
  type FaultyTransportConfig,
  type RequestLogEntry,
} from '@semiont/core/testing';

/**
 * Minimal in-memory `IContentTransport`. Stores what `putBinary` receives;
 * `getBinary` throws on unknown ids the way a real transport 404s, so a
 * test that forgets to seed content fails loudly instead of returning
 * fabricated bytes.
 */
function inMemoryContent(): IContentTransport {
  const store = new Map<string, { data: ArrayBuffer; contentType: string }>();
  const anchoredText = new Map<string, ExtractionOutcome>();
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
      store.set(rId as string, {
        data: await toBuffer(request.file),
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
    // Writes are checksum-addressed (PERSIST-ANCHORS P1b); reads stay
    // rid-addressed, resolved server-side through the view index — which this
    // double has no view to model, so seed reads by rid and expect writes to
    // land under the checksum the producer supplies.
    async putAnchoredText(checksum: string, anchored: ExtractionOutcome): Promise<void> {
      anchoredText.set(checksum, anchored);
    },
    async getAnchoredText(rId: ResourceId): Promise<ExtractionOutcome | null> {
      return anchoredText.get(String(rId)) ?? null;
    },
    // The cache-consult read (P2c): same map, checksum-keyed — coherent with
    // putAnchoredText's writes, so a put-then-consult round-trip hits.
    async getAnchoredTextByChecksum(checksum: string): Promise<ExtractionOutcome | null> {
      return anchoredText.get(checksum) ?? null;
    },
    async listAnchoredTextKeys(): Promise<string[]> {
      return [...anchoredText.keys()];
    },
    async getResourceGraph(rId: ResourceId): Promise<GetResourceResponse> {
      return { resource: { '@id': String(rId) } } as unknown as GetResourceResponse;
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
   * Backend operations for the `auth`/`admin` namespaces. Omitted = both are
   * `undefined` (transport-only client, same as production LocalTransport
   * setups). Pass `stubBackend()` when a unit under test touches
   * `client.auth` and the test scripts it via `AuthNamespace.prototype`
   * spies (the AuthShell precedent).
   */
  backend?: IBackendOperations;
  /**
   * `busRequest` timeout for the browse caches — the deterministic-time
   * knob (LIVENESS-AXIOMS P2a). Pass something small (e.g. 40) when a test
   * drives B14/B15 through timeouts; irrelevant for `reject-emit` faults.
   */
  busTimeoutMs?: number;
  /** Replace the in-memory content transport (e.g. to pre-seed bytes). */
  content?: IContentTransport;
  /** B17 persistence, for rehydration tests. Omitted = in-memory caches. */
  cachePersistence?: { storage: SessionStorage; keyPrefix: string };
}

/**
 * A real `SemiontClient` over a scriptable `FaultyTransport`.
 *
 * The returned `transport` IS the `FaultyTransport` instance — script faults
 * via its config, drive connection state via `transport.state$.next(...)`,
 * and account requests via `transport.requestLog`.
 */
/**
 * A COMPLETE `IBackendOperations` whose every method rejects loudly with its
 * own name — so a unit that touches an op the test didn't script fails with
 * "not scripted: <op>" instead of a fabricated success. Script behavior via
 * `AuthNamespace.prototype` / `AdminNamespace.prototype` spies, or spread
 * overrides over this stub. tsc enforces completeness: a new backend op is a
 * compile error HERE, not a silent gap.
 */
export function stubBackend(): IBackendOperations {
  const notScripted = (name: string) => () =>
    Promise.reject(new Error(`stubBackend: not scripted: ${name}`));
  return {
    authenticatePassword: notScripted('authenticatePassword'),
    authenticateGoogle: notScripted('authenticateGoogle'),
    refreshAccessToken: notScripted('refreshAccessToken'),
    logout: notScripted('logout'),
    acceptTerms: notScripted('acceptTerms'),
    getCurrentUser: notScripted('getCurrentUser'),
    getMediaToken: notScripted('getMediaToken'),
    listUsers: notScripted('listUsers'),
    getUserStats: notScripted('getUserStats'),
    updateUser: notScripted('updateUser'),
    getOAuthConfig: notScripted('getOAuthConfig'),
    backupKnowledgeBase: notScripted('backupKnowledgeBase'),
    // Observable-returning ops error their stream, same loudness.
    restoreKnowledgeBase: () =>
      throwError(() => new Error('stubBackend: not scripted: restoreKnowledgeBase')),
    exportKnowledgeBase: notScripted('exportKnowledgeBase'),
    importKnowledgeBase: () =>
      throwError(() => new Error('stubBackend: not scripted: importKnowledgeBase')),
    healthCheck: notScripted('healthCheck'),
    getStatus: notScripted('getStatus'),
  };
}

export function createTestClient(options: TestClientOptions = {}): {
  client: SemiontClient;
  transport: FaultyTransport;
} {
  const transport = new FaultyTransport(options.transport);
  const client = new SemiontClient(transport, options.content ?? inMemoryContent(), options.backend, {
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
 * state-unit factories, which take a session
 * (.plans/SESSION-TYPED-FACTORIES.md D1). No token is seeded and no
 * `validate`/`refresh` callbacks are wired, so `session.ready` settles
 * immediately; tests that need an authenticated shape push into `token$`.
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
      email: 'test@example.com',
      host: 'localhost',
      port: 4000,
      protocol: 'http',
    });
  const session = new SemiontSession({ kb, storage, client, token$ });
  return { session, client, transport, storage, token$ };
}
