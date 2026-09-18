/**
 * One in-memory `ITransport`, built through a typed signature with NO cast.
 *
 * Every transport double in this package used to be a hand-rolled object
 * literal behind `as unknown as ITransport` — 17 files, 25 doubles, each
 * restating the same interface slightly differently. The cast suppressed a
 * check the code was already asking for (those factories declared
 * `: ITransport` as their return type), and what it hid was not hypothetical:
 * removing it from ONE of them surfaced a bare `string` where the contract
 * wants the branded `BaseUrl`, an `emit` returning `Promise<void>` where the
 * contract returns the SUBSCRIBER COUNT, and `Observable<unknown>` where the
 * contract is `Observable<EventMap[K]>` — the per-channel typing
 * WORKER-BUS-TYPED-BY-CHANNEL exists to establish.
 *
 * The cost of that came due on 2026-09-16: `isSubscribed` became a required
 * member, all 25 doubles still compiled, and 139 tests here failed at RUNTIME
 * instead. In react-ui the same gap surfaced as an empty entity-type list,
 * because the `TypeError` was swallowed by the SWR cache's retry-then-idle
 * path and nothing named the cause.
 *
 * Constructed through this helper, the next required member is one compile
 * error in one file. Follows the pattern established by react-ui's
 * `inMemoryTransport` (PR #1384).
 *
 * `isSubscribed` answers `true` honestly rather than as a stub: `stream()`
 * returns the bus subject for whatever channel is asked, so this transport
 * genuinely does deliver every channel.
 */

import { vi } from 'vitest';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { EventBus, baseUrl } from '@semiont/core';
import type {
  ConnectionState,
  EventMap,
  BusEnvelope,
  IContentTransport,
  IGatewayOperations,
  ITransport,
  SemiontError,
} from '@semiont/core';

export interface InMemoryTransportOptions {
  /** The bus `stream`/`on` read from. Defaults to a fresh one. */
  bus?: EventBus;
  /**
   * Called on every emit. Adapted rather than taken as `ITransport['emit']`
   * so the interface contextually types `channel` and `payload` here and each
   * test still asserts on its own spy.
   */
  onEmit?: (
    channel: keyof EventMap,
    payload: EventMap[keyof EventMap],
    envelope?: BusEnvelope,
  ) => void;
  /** Subscriber count to report. Production returns the real count, and zero
   *  is what drives the gateway's unanswerable-request synthesis. */
  observers?: number;
  /**
   * Scope joins. Typed as the interface's own member so a test can pass a
   * spy straight through and still be checked against the contract.
   */
  subscribeToResource?: ITransport['subscribeToResource'];
  state$?: Observable<ConnectionState>;
  errors$?: Observable<SemiontError>;
}

export function inMemoryTransport(options: InMemoryTransportOptions = {}): ITransport {
  const {
    bus = new EventBus(),
    onEmit,
    observers = 1,
    subscribeToResource = () => () => {},
    state$ = new BehaviorSubject<ConnectionState>('open').asObservable(),
    errors$ = new Subject<SemiontError>().asObservable(),
  } = options;

  return {
    baseUrl: baseUrl('http://transport.test'),
    emit: async (channel, payload, envelope) => {
      // The envelope reaches the bus, so a scripted responder can echo the
      // correlation key back the way a real one does.
      bus.emit(channel, payload, envelope);
      onEmit?.(channel, payload, envelope);
      return observers;
    },
    on: (channel, handler) => {
      const sub = bus.on(channel).subscribe(handler);
      return () => sub.unsubscribe();
    },
    stream: (channel) => bus.on(channel),
    frames: (channel) => bus.frames(channel),
    subscribeToResource,
    bridgeInto: () => {},
    state$,
    errors$,
    isSubscribed: () => true,
    dispose: () => {},
  };
}

/**
 * The gateway-operations half, for the doubles that serve `SemiontClient`'s
 * third constructor argument as well as its transport.
 *
 * Each member is a spy TYPED as the interface's own method, so a test can
 * assert it was called while the compiler still checks the signature. Written
 * as `vi.fn<IGatewayOperations[K]>()` rather than a bare `vi.fn()` because the
 * bare form types as `Mock<Procedure>` and satisfies nothing — which is how
 * these doubles drifted from the contract behind their cast in the first
 * place.
 */
export function gatewayOperationSpies(
  overrides: Partial<IGatewayOperations> = {},
): IGatewayOperations {
  return {
    logout: vi.fn<IGatewayOperations['logout']>(),
    acceptTerms: vi.fn<IGatewayOperations['acceptTerms']>(),
    getCurrentUser: vi.fn<IGatewayOperations['getCurrentUser']>(),
    getProtectedResourceMetadata: vi.fn<IGatewayOperations['getProtectedResourceMetadata']>(),
    getMediaToken: vi.fn<IGatewayOperations['getMediaToken']>(),
    listUsers: vi.fn<IGatewayOperations['listUsers']>(),
    getUserStats: vi.fn<IGatewayOperations['getUserStats']>(),
    updateUser: vi.fn<IGatewayOperations['updateUser']>(),
    getOAuthConfig: vi.fn<IGatewayOperations['getOAuthConfig']>(),
    healthCheck: vi.fn<IGatewayOperations['healthCheck']>(),
    getStatus: vi.fn<IGatewayOperations['getStatus']>(),
    ...overrides,
  };
}

/** The content half, as typed spies, for tests that construct a client. */
export function contentTransportSpies(
  overrides: Partial<IContentTransport> = {},
): IContentTransport {
  return {
    putBinary: vi.fn<IContentTransport['putBinary']>(),
    getBinary: vi.fn<IContentTransport['getBinary']>(),
    getBinaryStream: vi.fn<IContentTransport['getBinaryStream']>(),
    getResourceGraph: vi.fn<IContentTransport['getResourceGraph']>(),
    dispose: vi.fn<IContentTransport['dispose']>(),
    ...overrides,
  };
}
