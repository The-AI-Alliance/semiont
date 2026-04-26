/**
 * LocalTransport — `ITransport` for an in-process `KnowledgeSystem`.
 *
 * Bus-ownership pattern (see `packages/core/docs/TRANSPORT-CONTRACT.md`):
 *   - The caller owns a make-meaning `EventBus` and passes it to both
 *     `startMakeMeaning` and `LocalTransport` so the transport can publish
 *     directly onto the bus the `KnowledgeSystem` actors are listening on.
 *   - `SemiontClient` constructs its own `clientBus` and calls
 *     `bridgeInto(clientBus)` during construction. `LocalTransport`
 *     subscribes to every `BRIDGED_CHANNELS` entry on the make-meaning bus
 *     and forwards each onto `clientBus`.
 *   - The bus reference flows client → transport, never the other way.
 *
 * Auth, admin, and exchange methods are not implemented in Phase 2 — local
 * mode runs as a single host-process identity supplied at construction.
 * Calling them throws.
 */

import type { Observable, Subscription } from 'rxjs';
import { BehaviorSubject } from 'rxjs';
import type {
  BaseUrl,
  Email,
  EventBus,
  EventMap,
  GoogleCredential,
  RefreshToken,
  ResourceId,
  UserDID,
  components,
} from '@semiont/core';
import { baseUrl as makeBaseUrl, busLog } from '@semiont/core';
import { SpanKind, recordBusEmit, withSpan } from '@semiont/observability';
import {
  BRIDGED_CHANNELS,
  type ConnectionState,
  type HealthCheckResponse,
  type ITransport,
  type ListUsersResponse,
  type ProgressCallback,
  type ProgressEvent,
  type StatusResponse,
  type UpdateUserRequest,
  type UpdateUserResponse,
  type UserResponse,
} from '@semiont/core';

import type { KnowledgeSystem } from './knowledge-system.js';

type AuthResponse = components['schemas']['AuthResponse'];
type TokenRefreshResponse = components['schemas']['TokenRefreshResponse'];
type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];

export interface LocalTransportConfig {
  /**
   * The in-process knowledge system. Lifetime is owned by the caller —
   * `dispose()` on this transport does not stop the KnowledgeSystem.
   */
  knowledgeSystem: KnowledgeSystem;
  /**
   * The make-meaning `EventBus`. Must be the same instance passed to
   * `startMakeMeaning` so that emits land on the bus KnowledgeSystem
   * actors are subscribed to.
   */
  eventBus: EventBus;
  /**
   * Host-process identity. Stamped onto every emit as `_userId`, mirroring
   * the gateway-injection convention used by `HttpTransport` (where the
   * `/bus/emit` gateway reads the JWT subject and injects `_userId`).
   * Handlers downstream trust nothing else.
   */
  userId: UserDID;
  /**
   * Cosmetic base URL for diagnostics and URL composition. Defaults to
   * `local://in-process`. Local code never makes outgoing HTTP requests
   * with it.
   */
  baseUrl?: BaseUrl;
}

const NOT_SUPPORTED = (method: string) =>
  new Error(`LocalTransport does not support ${method}() — local mode runs as a single host-process identity`);

export class LocalTransport implements ITransport {
  readonly baseUrl: BaseUrl;
  readonly state$: BehaviorSubject<ConnectionState>;

  private readonly bus: EventBus;
  private readonly userId: UserDID;
  private readonly bridges: EventBus[] = [];
  private readonly bridgeSubs: Subscription[] = [];
  private disposed = false;

  constructor(cfg: LocalTransportConfig) {
    this.bus = cfg.eventBus;
    this.userId = cfg.userId;
    this.baseUrl = cfg.baseUrl ?? makeBaseUrl('local://in-process');
    // Local "wire" is in-process. We start `open` and only close on dispose.
    this.state$ = new BehaviorSubject<ConnectionState>('open');
  }

  // ── Bus primitives ──────────────────────────────────────────────────────

  async emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    resourceScope?: ResourceId,
  ): Promise<void> {
    busLog('EMIT', channel as string, payload, resourceScope as string | undefined);
    recordBusEmit(channel as string, resourceScope as string | undefined);
    await withSpan(
      `bus.emit:${channel as string}`,
      () => {
        // Gateway-injection: stamp the host identity onto every emit so
        // handlers can trust `_userId` regardless of which transport
        // delivered the event.
        const stamped = { ...(payload as object), _userId: this.userId };
        const target = resourceScope === undefined
          ? this.bus.get(channel)
          : this.bus.scope(resourceScope as unknown as string).get(channel);
        (target as unknown as { next(v: unknown): void }).next(stamped);
      },
      {
        kind: SpanKind.PRODUCER,
        attrs: {
          'bus.channel': channel as string,
          ...(resourceScope ? { 'bus.scope': resourceScope as string } : {}),
        },
      },
    );
  }

  on<K extends keyof EventMap>(channel: K, handler: (payload: EventMap[K]) => void): () => void {
    const sub = (this.bus.get(channel) as unknown as Observable<EventMap[K]>).subscribe(handler);
    return () => sub.unsubscribe();
  }

  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.bus.get(channel) as unknown as Observable<EventMap[K]>;
  }

  subscribeToResource(_resourceId: ResourceId): () => void {
    // Local events are not scope-gated for delivery; emits to a scoped
    // channel still land on `bus.scope(...)` and any subscriber to that
    // scoped subject receives them. There is no ambient scope to "join".
    return () => {};
  }

  bridgeInto(bus: EventBus): void {
    if (this.bridges.includes(bus)) return;
    this.bridges.push(bus);
    for (const channel of BRIDGED_CHANNELS) {
      const upstream = this.bus.get(channel as keyof EventMap) as unknown as Observable<unknown>;
      this.bridgeSubs.push(
        upstream.subscribe((payload) => {
          busLog('RECV', channel, payload);
          // Tier 2: in-process — no _trace field on payload, parent
          // context comes from the active OTel context (inherited from
          // whichever code path emitted the event).
          void withSpan(
            `bus.recv:${channel}`,
            () => {
              (bus.get(channel as keyof EventMap) as unknown as { next(v: unknown): void }).next(payload);
            },
            { kind: SpanKind.CONSUMER, attrs: { 'bus.channel': channel } },
          );
        }),
      );
    }
  }

  // ── Auth (not supported) ────────────────────────────────────────────────

  async authenticatePassword(_email: Email, _password: string): Promise<AuthResponse> {
    throw NOT_SUPPORTED('authenticatePassword');
  }
  async authenticateGoogle(_credential: GoogleCredential): Promise<AuthResponse> {
    throw NOT_SUPPORTED('authenticateGoogle');
  }
  async refreshAccessToken(_token: RefreshToken): Promise<TokenRefreshResponse> {
    throw NOT_SUPPORTED('refreshAccessToken');
  }
  async logout(): Promise<void> {
    // No-op: nothing to invalidate in-process.
  }
  async acceptTerms(): Promise<void> {
    // No-op: terms acceptance is a server-side user record; local mode has none.
  }
  async getCurrentUser(): Promise<UserResponse> {
    // Synthesize a user record from the constructor-supplied identity. Tests
    // that need richer user state should attach a Users-DB-backed transport.
    return {
      did: this.userId as unknown as string,
      email: '',
      isAdmin: false,
      isModerator: false,
      termsAcceptedAt: null,
    } as unknown as UserResponse;
  }
  async generateMcpToken(): Promise<{ token: string }> {
    throw NOT_SUPPORTED('generateMcpToken');
  }
  async getMediaToken(_resourceId: ResourceId): Promise<{ token: string }> {
    throw NOT_SUPPORTED('getMediaToken');
  }

  // ── Admin (not supported) ───────────────────────────────────────────────

  async listUsers(): Promise<ListUsersResponse> {
    throw NOT_SUPPORTED('listUsers');
  }
  async getUserStats(): Promise<AdminUserStatsResponse> {
    throw NOT_SUPPORTED('getUserStats');
  }
  async updateUser(_id: UserDID, _data: UpdateUserRequest): Promise<UpdateUserResponse> {
    throw NOT_SUPPORTED('updateUser');
  }
  async getOAuthConfig(): Promise<OAuthConfigResponse> {
    throw NOT_SUPPORTED('getOAuthConfig');
  }

  // ── Exchange (not supported) ────────────────────────────────────────────

  async backupKnowledgeBase(): Promise<Response> {
    throw NOT_SUPPORTED('backupKnowledgeBase');
  }
  async restoreKnowledgeBase(_file: File, _onProgress?: ProgressCallback): Promise<ProgressEvent> {
    throw NOT_SUPPORTED('restoreKnowledgeBase');
  }
  async exportKnowledgeBase(_params?: { includeArchived?: boolean }): Promise<Response> {
    throw NOT_SUPPORTED('exportKnowledgeBase');
  }
  async importKnowledgeBase(_file: File, _onProgress?: ProgressCallback): Promise<ProgressEvent> {
    throw NOT_SUPPORTED('importKnowledgeBase');
  }

  // ── System ──────────────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResponse> {
    return { status: 'ok' } as unknown as HealthCheckResponse;
  }
  async getStatus(): Promise<StatusResponse> {
    return { status: 'ok' } as unknown as StatusResponse;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sub of this.bridgeSubs) sub.unsubscribe();
    this.bridgeSubs.length = 0;
    this.bridges.length = 0;
    this.state$.next('closed');
    this.state$.complete();
  }
}
