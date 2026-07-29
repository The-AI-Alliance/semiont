/**
 * makeTestClient — structurally-typed `SemiontClient` stand-in for state unit
 * factory tests. Exposes a real `EventBus` as `client.bus` (the same
 * shape production code reads), plus whatever HTTP namespaces the caller
 * supplies via `overrides`.
 *
 * Usage:
 *
 * ```ts
 * // bus-only state unit
 * const { bus, client } = makeTestClient();
 * const stateUnit = createShellStateUnit(client);
 * client.bus.get('panel:toggle').next({ panel: 'annotations' });
 * bus.destroy(); // in afterEach
 *
 * // state unit that also calls HTTP namespaces
 * const { client } = makeTestClient({
 *   mark: {
 *     annotation: vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
 *     delete: vi.fn().mockResolvedValue(undefined),
 *   },
 * });
 * const stateUnit = createMarkStateUnit(client, resourceId);
 * ```
 *
 * The `client` is cast `as unknown as SemiontClient`, matching the
 * established pattern for structural mocks in this codebase.
 */

import { BehaviorSubject, Subject } from 'rxjs';
import { EventBus } from '@semiont/core';
import type { ConnectionState, SemiontError } from '@semiont/core';
import type { SemiontClient, SemiontSession } from '@semiont/sdk';
import { SemiontSession as RealSemiontSession, httpKb, InMemorySessionStorage } from '@semiont/sdk';
import type { AccessToken } from '@semiont/core';

export interface TestClient {
  /** The real bus backing `client.bus` — exposed so tests can
   *  destroy() it in afterEach. Same instance as `client.bus`. */
  bus: EventBus;
  client: SemiontClient;
}

export function makeTestClient(
  overrides: Record<string, unknown> = {},
): TestClient {
  const bus = new EventBus();
  const client = {
    // Surfaces a REAL `SemiontSession` reads at construction — present by
    // default so `makeTestSession` can wrap this client; overridable.
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    transport: { errors$: new Subject<SemiontError>().asObservable() },
    ...overrides,
    bus,
  } as unknown as SemiontClient;
  return { bus, client };
}

export interface TestSession extends TestClient {
  /** A REAL `SemiontSession` wrapping the structural client above — for
   *  session-typed factories (SESSION-TYPED-FACTORIES.md D1). The session
   *  machinery (id, kb, token$) is real; only the client seam is scripted. */
  session: SemiontSession;
}

export function makeTestSession(
  overrides: Record<string, unknown> = {},
): TestSession {
  const { bus, client } = makeTestClient(overrides);
  const session = new RealSemiontSession({
    kb: httpKb({
      id: 'test-kb',
      label: 'Test KB',
      email: 'test@example.com',
      host: 'localhost',
      port: 4000,
      protocol: 'http',
    }),
    storage: new InMemorySessionStorage(),
    client,
    token$: new BehaviorSubject<AccessToken | null>(null),
  });
  return { bus, client, session };
}

/**
 * Wrap a structural client mock in a REAL `SemiontSession` — the bridge for
 * factory tests whose subject is unit logic over a scripted client seam
 * (SESSION-TYPED-FACTORIES.md D1). Supplies the two surfaces the session
 * constructor reads (`state$`, `transport.errors$`) when the mock lacks
 * them; the mock's own members win when present. Same documented
 * structural-mock cast this helper already uses.
 */
export function sessionOf(client: SemiontClient): SemiontSession {
  const complete = {
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    transport: { errors$: new Subject<SemiontError>().asObservable() },
    ...(client as unknown as Record<string, unknown>),
  } as unknown as SemiontClient;
  return new RealSemiontSession({
    kb: httpKb({
      id: 'test-kb',
      label: 'Test KB',
      email: 'test@example.com',
      host: 'localhost',
      port: 4000,
      protocol: 'http',
    }),
    storage: new InMemorySessionStorage(),
    client: complete,
    token$: new BehaviorSubject<AccessToken | null>(null),
  });
}
