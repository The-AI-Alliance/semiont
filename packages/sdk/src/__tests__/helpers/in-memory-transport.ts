/**
 * One in-memory `ITransport`, built through a typed signature with NO cast.
 *
 * A hand-rolled object literal behind `as unknown as ITransport` suppresses
 * the check its own `: ITransport` return type asks for, and what a cast
 * hides is not hypothetical: a bare `string` where the contract wants the
 * branded `BaseUrl`, an `emit` returning `Promise<void>` where the contract
 * returns the SUBSCRIBER COUNT, and `Observable<unknown>` where the contract
 * is `Observable<EventMap[K]>` — the per-channel typing that derives a
 * payload's type from its channel name.
 *
 * A cast also defers a new required member to RUNTIME: every double behind
 * one compiles without it, and its tests fail when they run — or the
 * `TypeError` is swallowed by the SWR cache's retry-then-idle path and
 * surfaces as an empty list, with nothing naming the cause.
 *
 * Constructed through this helper, the next required member is one compile
 * error in one file.
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
    trackReply: () => () => {},
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
 * bare form types as `Mock<Procedure>` and satisfies nothing, so it needs a
 * cast, and a double behind a cast drifts from the contract.
 */
export function gatewayOperationSpies(
  overrides: Partial<IGatewayOperations> = {},
): IGatewayOperations {
  return {
    getCurrentUser: vi.fn<IGatewayOperations['getCurrentUser']>(),
    getProtectedResourceMetadata: vi.fn<IGatewayOperations['getProtectedResourceMetadata']>(),
    getMediaToken: vi.fn<IGatewayOperations['getMediaToken']>(),
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
