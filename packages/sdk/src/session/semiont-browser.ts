/**
 * SemiontBrowser — top-level app-facing container for non-KB state.
 *
 * Holds the list of configured KBs, the active KB selection, the active
 * SemiontSession, the identity token, the open-resources list, and a
 * session-level error stream. Held as a process-wide instance for the
 * host's lifetime — see `getBrowser()` in `registry.ts` for the canonical
 * accessor.
 *
 * Transport-agnostic: the browser orchestrates session *lifecycle* but
 * delegates session *construction* to a `SessionFactory` injected at
 * construction. HTTP-backed apps pass `createHttpSessionFactory()` from
 * `@semiont/sdk`; in-process apps pass their own factory.
 *
 * Persistence goes through a `SessionStorage` adapter provided at
 * construction — the browser never touches `localStorage` or `window`
 * directly.
 */

import { BehaviorSubject, Subject, type Observable } from 'rxjs';
import {
  BusRequestError,
  EventBus,
  getPrimaryRepresentation,
  resourceId,
  type EventMap,
} from '@semiont/core';
import {
  ACTIVE_KEY,
  clearStoredSession,
  generateKbId,
  getStoredSession,
  isJwtExpired,
  loadKnowledgeBases,
  OPEN_RESOURCES_BY_KB_KEY,
  LAST_VIEWED_RESOURCE_BY_KB_KEY,
  saveKnowledgeBases,
  setStoredSession,
  type StoredSession,
} from './storage';
import {
  BROWSER_CLIENT_ID,
  beginAuthorization,
  completeAuthorization,
  revokeAtIssuer,
  type BeginAuthorizationOptions,
} from './oauth';
import { describeConnection } from './connect';
import type {
  KnowledgeBase,
  KbSessionStatus,
  NewKnowledgeBase,
} from './knowledge-base';
import {
  applyTabChecks,
  sortOpenResources,
  type OpenResource,
  type TabCheck,
} from './open-resource';
import { SemiontSession } from './semiont-session';
import { SessionSignals } from './session-signals';
import { SemiontSessionError } from './errors';
import type { SessionStorage } from './session-storage';
import type { SessionFactory } from './session-factory';

/**
 * Tabs are per-KB state: Record<kbId, OpenResource[]>. State from the
 * retired flat `openDocuments` key is deliberately ignored (it never
 * recorded which KB its entries belonged to).
 */
function loadOpenResourcesByKb(storage: SessionStorage): Record<string, OpenResource[]> {
  try {
    const stored = storage.get(OPEN_RESOURCES_BY_KB_KEY);
    if (stored) return JSON.parse(stored) as Record<string, OpenResource[]>;
  } catch {
    // Ignore parse errors
  }
  return {};
}

/** Per-KB last-viewed resource: Record<kbId, resourceId>. */
function loadLastViewedByKb(storage: SessionStorage): Record<string, string> {
  try {
    const stored = storage.get(LAST_VIEWED_RESOURCE_BY_KB_KEY);
    if (stored) return JSON.parse(stored) as Record<string, string>;
  } catch {
    // Ignore parse errors
  }
  return {};
}

/**
 * What a completed sign-in registered or re-authenticated, plus what the
 * user believed they were connecting to — a discovered row they clicked, or
 * the registered record they re-authenticated — so a host can verify the
 * two against each other and report a mismatch. Verification reports; it
 * never blocks, because the KB that answered is the one they reached.
 */
export interface SignInOutcome {
  kb: KnowledgeBase;
  expected?: { did: string; name?: string };
}

export interface SemiontBrowserConfig {
  /** Persistence adapter. The browser reads/writes all persisted state via this. */
  storage: SessionStorage;
  /**
   * Builds a `SemiontSession` for a KB. The browser is transport-
   * agnostic — every HTTP-vs-local construction concern lives in the
   * factory. HTTP-backed apps pass `createHttpSessionFactory()` from
   * `@semiont/sdk`; a future in-process variant from `@semiont/make-meaning`
   * would expose its own factory.
   */
  sessionFactory: SessionFactory;
}

export class SemiontBrowser {
  readonly kbs$: BehaviorSubject<KnowledgeBase[]>;
  readonly activeKbId$: BehaviorSubject<string | null>;
  readonly activeSession$: BehaviorSubject<SemiontSession | null>;
  /**
   * Modal signals (session-expired / permission-denied) for the
   * currently-active session. Parallels `activeSession$` — always
   * non-null when `activeSession$` is non-null, always null when it
   * is. Extracted from the session itself so headless sessions
   * (workers, CLIs, tests) don't carry dead modal observables.
   * See [SessionSignals](./session-signals.ts).
   */
  readonly activeSignals$: BehaviorSubject<SessionSignals | null>;
  /**
   * True while a session is actively being constructed (setActiveKb /
   * signIn in flight, awaiting `session.ready`). Distinguishes the
   * "session about to arrive" intermediate state from "session
   * intentionally null" (after signOut, or when the active KB has no
   * stored credentials). UIs that want a loading spinner should gate
   * on this; otherwise they get stuck spinning after every signOut.
   */
  readonly sessionActivating$: BehaviorSubject<boolean>;
  readonly openResources$: BehaviorSubject<OpenResource[]>;
  /**
   * The active, connected KB's last-viewed resource id — "where was I?" for
   * a landing route to resume from. Per-KB like `openResources$`: null while
   * nothing is connected, and never carrying one KB's id into another.
   */
  readonly lastViewedResource$: BehaviorSubject<string | null>;
  readonly error$: Subject<SemiontSessionError>;
  readonly identityToken$: BehaviorSubject<string | null>;

  private readonly storage: SessionStorage;
  private readonly sessionFactory: SessionFactory;
  /**
   * App-scoped EventBus. Hosts UI-shell events that must work regardless
   * of whether a KB session is active: panel toggles, sidebar state,
   * tab reorders, routing, settings, etc. Disjoint from the per-session
   * bus inside `SemiontClient`, which carries KB-content events
   * (mark:*, beckon:*, gather:*, match:*, bind:*, yield:*, browse:click).
   */
  private readonly eventBus: EventBus = new EventBus();
  private unsubscribeStorage: (() => void) | null = null;
  private disposed = false;
  private activating: Promise<void> | null = null;
  /** Per-KB tab lists; `openResources$` projects the active, connected KB's. */
  private openByKb: Record<string, OpenResource[]> = {};
  /** The session whose tabs have been validated — the once-per-activation guard. */
  private validatedFor: SemiontSession | null = null;
  /** Per-KB last-viewed resource; `lastViewedResource$` projects the active, connected KB's. */
  private lastViewedByKb: Record<string, string> = {};

  constructor(config: SemiontBrowserConfig) {
    this.storage = config.storage;
    this.sessionFactory = config.sessionFactory;

    const kbs = loadKnowledgeBases(this.storage);
    const storedActive = this.storage.get(ACTIVE_KEY);
    const initialActive =
      storedActive && kbs.some((kb) => kb.id === storedActive)
        ? storedActive
        : kbs[0]?.id ?? null;

    this.kbs$ = new BehaviorSubject<KnowledgeBase[]>(kbs);
    this.activeKbId$ = new BehaviorSubject<string | null>(initialActive);
    this.activeSession$ = new BehaviorSubject<SemiontSession | null>(null);
    this.activeSignals$ = new BehaviorSubject<SessionSignals | null>(null);
    this.sessionActivating$ = new BehaviorSubject<boolean>(false);
    this.openByKb = loadOpenResourcesByKb(this.storage);
    this.openResources$ = new BehaviorSubject<OpenResource[]>([]);
    this.lastViewedByKb = loadLastViewedByKb(this.storage);
    this.lastViewedResource$ = new BehaviorSubject<string | null>(null);
    this.error$ = new Subject<SemiontSessionError>();
    this.identityToken$ = new BehaviorSubject<string | null>(null);

    // Persist kbs$ and activeKbId$ via the storage adapter.
    this.kbs$.subscribe((next) => saveKnowledgeBases(this.storage, next));
    this.activeKbId$.subscribe((id) => {
      if (id) this.storage.set(ACTIVE_KEY, id);
      else this.storage.delete(ACTIVE_KEY);
    });

    // The visible tab list and the last-viewed resource are projections of
    // the active, CONNECTED KB (gate: a live session). Connect/disconnect/
    // switch all surface as activeSession$ transitions, so one subscription
    // re-projects both; CRUD and cross-tab writes refresh explicitly.
    this.activeSession$.subscribe((session) => {
      this.refreshOpenResources();
      this.refreshLastViewedResource();
      // Rehydrate, THEN revalidate (D1). The list above projects immediately
      // — fast and offline-tolerant — and the claims in it are checked once
      // there is a session to ask. Fire-and-forget: nothing waits on it, and
      // a tab that fails to check simply stays.
      void this.validateOpenResources(session);
    });

    // Sync the per-KB maps from other contexts (cross-tab/cross-process).
    this.unsubscribeStorage = this.storage.subscribe?.((key, newValue) => {
      if (!newValue) return;
      try {
        if (key === OPEN_RESOURCES_BY_KB_KEY) {
          this.openByKb = JSON.parse(newValue) as Record<string, OpenResource[]>;
          this.refreshOpenResources();
        } else if (key === LAST_VIEWED_RESOURCE_BY_KB_KEY) {
          this.lastViewedByKb = JSON.parse(newValue) as Record<string, string>;
          this.refreshLastViewedResource();
        }
      } catch {
        // Ignore parse errors
      }
    }) ?? null;

    // Construct the initial active session, if any. Fire-and-forget.
    if (initialActive) {
      void this.setActiveKb(initialActive);
    }
  }

  // ── App-scoped event bus ──────────────────────────────────────────────

  /** Emit an event on the browser's app-scoped bus. */
  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
    if (this.disposed) return;
    this.eventBus.emit(channel, payload);
  }

  /** Subscribe to an event; returns unsubscribe. */
  on<K extends keyof EventMap>(
    channel: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    const sub = this.eventBus.on(channel).subscribe(handler);
    return () => sub.unsubscribe();
  }

  /** Read-only observable for an app-scoped channel. */
  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.eventBus.on(channel);
  }

  // ── Identity token (external OAuth/identity bridge; D1) ───────────────

  /**
   * Set the app-level identity token. Sourced from an external
   * OAuth/identity-provider token supplied by the host environment.
   * Should be called once from the host's startup-and-on-change site;
   * no other code should write to this slot.
   */
  setIdentityToken(token: string | null): void {
    if (this.disposed) return;
    this.identityToken$.next(token);
  }

  // ── KB list management ────────────────────────────────────────────────

  addKb(input: NewKnowledgeBase, session: StoredSession): KnowledgeBase {
    const kb: KnowledgeBase = { id: generateKbId(), ...input };
    setStoredSession(this.storage, kb.id, session);
    this.kbs$.next([...this.kbs$.getValue(), kb]);
    void this.setActiveKb(kb.id);
    return kb;
  }

  // ── Sign-in through the issuer a KB trusts ────────────────────────────

  /**
   * Start a sign-in: discover the issuer the target trusts, remember the
   * pending authorization, and return the URL the host must navigate the
   * user to. Navigation is the host's act — a browser assigns
   * `window.location`, a test asserts the URL.
   */
  async beginSignIn(opts: BeginAuthorizationOptions): Promise<string> {
    return beginAuthorization(opts, this.storage);
  }

  /**
   * Finish a sign-in from the URL the issuer returned the user to: exchange
   * the code, ask the KB who it is and who the user is, then register the
   * KB (a new address) or re-authenticate it (a registered one, by id or by
   * the same address). Throws `SignInError` for the OAuth half and
   * `IdentityUnverifiableError` when the KB cannot say who it is.
   */
  async completeSignIn(callbackUrl: string): Promise<SignInOutcome> {
    const { pending, tokens } = await completeAuthorization(callbackUrl, this.storage);
    const identity = await describeConnection(pending.target, tokens.access);
    const session: StoredSession = {
      access: tokens.access,
      refresh: tokens.refresh,
      clientId: BROWSER_CLIENT_ID,
      tokenEndpoint: pending.issuer.token,
      ...(pending.issuer.revocation ? { revocationEndpoint: pending.issuer.revocation } : {}),
    };
    const kbs = this.kbs$.getValue();
    const existing = pending.kbId
      ? kbs.find((kb) => kb.id === pending.kbId)
      : kbs.find((kb) =>
          kb.endpoint.kind === 'http'
          && kb.endpoint.host === pending.target.host
          && kb.endpoint.port === pending.target.port);
    const expected = pending.expectedDid
      ? { did: pending.expectedDid, ...(pending.expectedName ? { name: pending.expectedName } : {}) }
      : existing
        ? { did: existing.did, ...(existing.label ? { name: existing.label } : {}) }
        : undefined;
    const branch = identity.gitBranch ? { gitBranch: identity.gitBranch } : {};
    if (existing) {
      const kb: KnowledgeBase = { ...existing, label: identity.label, email: identity.email, ...branch };
      this.updateKb(existing.id, { label: identity.label, email: identity.email, ...branch });
      await this.signIn(existing.id, session);
      return { kb, ...(expected ? { expected } : {}) };
    }
    const kb = this.addKb(
      { did: identity.did, label: identity.label, email: identity.email, endpoint: pending.target, ...branch },
      session,
    );
    return { kb, ...(expected ? { expected } : {}) };
  }

  removeKb(id: string): void {
    clearStoredSession(this.storage, id);
    // Reap the KB's tab record — removal of the connection is the one
    // deliberate act that forgets the working set.
    if (this.openByKb[id]) {
      const rest = { ...this.openByKb };
      delete rest[id];
      this.openByKb = rest;
      this.persistOpenResources();
    }
    if (this.lastViewedByKb[id]) {
      const rest = { ...this.lastViewedByKb };
      delete rest[id];
      this.lastViewedByKb = rest;
      this.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, JSON.stringify(this.lastViewedByKb));
    }
    const next = this.kbs$.getValue().filter((kb) => kb.id !== id);
    this.kbs$.next(next);
    if (this.activeKbId$.getValue() === id) {
      void this.setActiveKb(next[0]?.id ?? null);
    }
  }

  /**
   * Patch a KB in the list. Restricted to the common, endpoint-agnostic
   * fields (`label`, `email`, `gitBranch`) — the `endpoint` shape isn't
   * editable in place; remove and re-add to change the connection
   * target.
   */
  updateKb(id: string, updates: { label?: string; email?: string; gitBranch?: string }): void {
    this.kbs$.next(
      this.kbs$.getValue().map((kb) => (kb.id === id ? { ...kb, ...updates } : kb)),
    );
  }

  /**
   * Read the locally-stored credential status for a KB. Pure / synchronous —
   * does not subscribe to context changes. Used by KB-list UI to color status
   * dots without requiring re-renders on every tick.
   */
  getKbSessionStatus(kbId: string): KbSessionStatus {
    const stored = getStoredSession(this.storage, kbId);
    if (!stored) return 'signed-out';
    return isJwtExpired(stored.access) ? 'expired' : 'authenticated';
  }

  /**
   * Switch the active KB. Follows the D2 disposal contract:
   *   1. Synchronously announce the new id on `activeKbId$` and null out
   *      `activeSession$` so views see a safe empty state first.
   *   2. Serialize overlapping calls — if an activation is in flight, wait
   *      for it before proceeding.
   *   3. Dispose whatever session is currently live.
   *   4. Construct the next session and await `session.ready`.
   *   5. Before emitting, re-check `activeKbId$` — if a newer call superseded
   *      us while we waited, dispose our session and skip the emit.
   *   6. Emit the new session.
   */
  async setActiveKb(id: string | null): Promise<void> {
    if (this.disposed) return;

    const prevId = this.activeKbId$.getValue();
    const prevSession = this.activeSession$.getValue();

    // No-op if id already matches and a live session exists.
    if (id === prevId && prevSession) return;

    // Synchronous intent signal. Late activations compare against this to
    // detect staleness. Session and signals null out together so React
    // consumers never see a stale signals instance paired with a null
    // session during the activation gap.
    if (prevId !== id) this.activeKbId$.next(id);
    if (prevSession) {
      this.activeSession$.next(null);
      this.activeSignals$.next(null);
    }

    // Wait for any in-flight activation. If we were superseded while
    // waiting, bail — a newer call is already reflecting the desired state.
    while (this.activating) {
      const current = this.activating;
      await current;
      if (this.disposed) return;
      if (this.activeKbId$.getValue() !== id) return;
    }

    const activation = (async () => {
      // Dispose whatever is currently live (might be null already from the
      // sync path above, or left over from a superseded activation).
      const toDispose = this.activeSession$.getValue();
      const signalsToDispose = this.activeSignals$.getValue();
      if (toDispose) {
        this.activeSession$.next(null);
        this.activeSignals$.next(null);
        await toDispose.dispose();
        signalsToDispose?.dispose();
      }

      if (!id) return;

      const kb = this.kbs$.getValue().find((k) => k.id === id);
      if (!kb) return;

      // Construct the modal signals up front; the session's
      // onAuthFailed callback writes into them, so they must exist
      // before the session's ctor does its startup validation.
      const signals = new SessionSignals();

      let session: SemiontSession;
      try {
        session = this.sessionFactory({
          kb,
          storage: this.storage,
          signals,
          onError: (err) => this.error$.next(err),
        });
      } catch (err) {
        this.error$.next(
          err instanceof SemiontSessionError
            ? err
            : new SemiontSessionError(
                'session.construct-failed',
                err instanceof Error ? err.message : String(err),
                id,
              ),
        );
        signals.dispose();
        return;
      }

      // Route transport-level errors through RECOVERY, not straight to the
      // modal. A single `unauthorized` is not session death: requests race
      // the refresh window, and the old direct wire fired "Session Expired
      // — HTTP 401" over sessions that healed a beat later — and, for a
      // truly dead session, WITHOUT clearing storage, so every reload
      // restored the corpse and re-armed an effectively undismissable modal
      // (both its buttons navigate — into the same loop; found live
      // 2026-09-14). `session.refresh()` covers both ends: success heals in
      // silence; exhaustion runs the session's own teardown — stored session
      // cleared, `onAuthFailed` fires the modal once, with the session's own
      // message instead of the raw transport line. `forbidden` has no
      // recovery — surface it as permission-denied, unchanged. The
      // subscription ends naturally when `errors$` completes on dispose.
      session.errors$.subscribe((err) => {
        if (err.code === 'unauthorized') {
          void session.refresh();
        } else if (err.code === 'forbidden') {
          signals.notifyPermissionDenied(err.message);
        }
      });

      try {
        await session.ready;
      } catch (err) {
        this.error$.next(
          new SemiontSessionError(
            'session.construct-failed',
            err instanceof Error ? err.message : String(err),
            id,
          ),
        );
        await session.dispose();
        signals.dispose();
        return;
      }

      if (this.disposed || this.activeKbId$.getValue() !== id) {
        await session.dispose();
        signals.dispose();
        return;
      }

      // Signals BEFORE the session, deliberately: emitting the session is
      // what drives the activation-time validation pass, and an identity
      // conflict is reported through the signals — so they have to be
      // readable by the time that pass runs.
      this.activeSignals$.next(signals);
      this.activeSession$.next(session);
    })();

    this.activating = activation;
    this.sessionActivating$.next(true);
    try {
      await activation;
    } finally {
      // Reference-identity guard: clear only if no newer activate() superseded
      // us. Do NOT await `activation` here (it resolves to void) — awaiting would
      // make this always-false and leak the activating state. (CodeQL FP.)
      if (this.activating === activation) {
        this.activating = null;
        this.sessionActivating$.next(false);
      }
    }
  }

  /**
   * Sign in to an existing KB: store the tokens and (re)activate the
   * session. If the KB is already active, the current session is disposed
   * and replaced so the new tokens take effect.
   */
  async signIn(id: string, session: StoredSession): Promise<void> {
    if (this.disposed) return;
    setStoredSession(this.storage, id, session);

    // If this KB is already active, tear down and reconstruct so the new
    // tokens are picked up from storage by the session ctor.
    if (this.activeKbId$.getValue() === id) {
      const prevSession = this.activeSession$.getValue();
      const prevSignals = this.activeSignals$.getValue();
      this.activeSession$.next(null);
      this.activeSignals$.next(null);
      if (prevSession) await prevSession.dispose();
      prevSignals?.dispose();
      await this.setActiveKb(id);
      return;
    }

    await this.setActiveKb(id);
  }

  /**
   * Sign out of a KB: forget the stored tokens and, best-effort, revoke the
   * refresh token at the issuer that issued it. If the KB is active,
   * dispose its session + signals and emit null for both.
   */
  async signOut(id: string): Promise<void> {
    if (this.disposed) return;
    const stored = getStoredSession(this.storage, id);
    clearStoredSession(this.storage, id);
    if (stored?.revocationEndpoint) {
      // The local act is the sign-out; an unreachable issuer must not trap
      // the user in a session they asked to end.
      void revokeAtIssuer(stored.revocationEndpoint, stored.clientId, stored.refresh).catch(() => {});
    }

    // Bump the kbs$ list so downstream status-derivations re-run.
    this.kbs$.next([...this.kbs$.getValue()]);

    if (this.activeKbId$.getValue() === id) {
      const prevSession = this.activeSession$.getValue();
      const prevSignals = this.activeSignals$.getValue();
      this.activeSession$.next(null);
      this.activeSignals$.next(null);
      if (prevSession) await prevSession.dispose();
      prevSignals?.dispose();
    }
  }

  // ── Open resources (per-KB; the visible list is a projection) ─────────

  private refreshOpenResources(): void {
    const kbId = this.activeKbId$.getValue();
    const session = this.activeSession$.getValue();
    const list = kbId && session ? sortOpenResources(this.openByKb[kbId] ?? []) : [];
    this.openResources$.next(list);
  }

  private persistOpenResources(): void {
    this.storage.set(OPEN_RESOURCES_BY_KB_KEY, JSON.stringify(this.openByKb));
  }

  /**
   * Check every restored tab against the KB it claims to be from, and drop
   * the ones the KB says are not there (TABS-REVALIDATE-ON-RESTORE P3).
   *
   * Runs once per ACTIVATION, not per projection: CRUD and cross-tab writes
   * re-project constantly, and re-reading every descriptor on each of those
   * would be a different feature. Guarded on the session identity rather than
   * a boolean so a KB switch — which is an activation — validates the newly
   * active list.
   *
   * Quiet by design (D4): failures other than `not-found` are logged, and a
   * removal needs no toast. The phantom silently ceasing to exist IS the
   * correct outcome.
   */
  private async validateOpenResources(session: SemiontSession | null): Promise<void> {
    const kbId = this.activeKbId$.getValue();
    if (!session || !kbId || this.validatedFor === session) return;
    this.validatedFor = session;

    // Identity first, and it short-circuits (KB-IDENTITY D5). If a different
    // knowledge base is answering, every per-resource verdict below is an
    // answer to a question asked of the wrong KB — meaningless even when it
    // is `not-found`. One pass, one guard: two async passes racing on one
    // activation is how the guard would stop meaning anything.
    if (await this.voidIfIdentityChanged(session, kbId)) return;

    // Committed state here too, for the same reason `mutateOpenResources`
    // reads it: a sibling context may have added a tab before this session
    // activated, and that tab deserves checking like any other.
    const ids = (loadOpenResourcesByKb(this.storage)[kbId] ?? []).map((tab) => tab.id);
    if (ids.length === 0) return;

    const checks = new Map<string, TabCheck>();
    // Bounded concurrency (D4). Tab counts are small, so a fixed lane count
    // beats any cleverer scheduler; the point is to not open N requests at
    // once on a connection that just came up.
    const lanes = Array.from({ length: Math.min(4, ids.length) }, async () => {
      for (;;) {
        const id = ids.shift();
        if (id === undefined) return;
        checks.set(id, await this.checkOpenResource(session, id));
      }
    });
    await Promise.all(lanes);

    // D4: logged, not surfaced — and aggregated, because an activation while
    // the archivist is down would otherwise emit one line per tab.
    const inconclusive = [...checks.values()].filter((c) => c.kind === 'unknown').length;
    if (inconclusive > 0) {
      // eslint-disable-next-line no-console
      console.debug(
        `[tabs] ${inconclusive} of ${checks.size} open resources could not be checked; keeping them`,
      );
    }

    if (this.disposed || this.activeSession$.getValue() !== session) return;
    this.mutateOpenResources((list) => applyTabChecks(list, checks));
  }

  /**
   * Verify this KB is still the KB the registry entry claims, and void the
   * state that is a claim about its contents if it is not
   * (KB-IDENTITY-CHECKED-ON-ACTIVATION P1). Returns whether it voided.
   *
   * **The did is read in one direction only (D1).** A did is not unique — a
   * local clone and a codespace of one repo share one — so it is authoritative
   * for *differs* and says nothing for *matches*. A match concludes nothing
   * about the contents; that is the wipe, and it is the per-resource pass's
   * question.
   *
   * **No verdict is not a mismatch (D3), and this must never be weakened.** A
   * status call that rejects, a response with no did, and a transport with no
   * admin namespace at all are three different absences, and none of them is
   * evidence of anything. Losing a user's tabs because the gateway was briefly
   * down is strictly worse than the phantoms this addresses.
   */
  private async voidIfIdentityChanged(session: SemiontSession, kbId: string): Promise<boolean> {
    const expectedDid = this.kbs$.getValue().find((k) => k.id === kbId)?.did;
    if (!expectedDid) return false;

    let observedDid: string | undefined;
    try {
      // `admin` is undefined by TRANSPORT capability, not user role: a
      // `kind: 'local'` endpoint has no admin routes in-process and never
      // will. `/api/status` itself needs authentication but not an admin
      // role, so this is readable by any signed-in user.
      observedDid = (await session.client.system?.status())?.did;
    } catch {
      return false; // unreachable — a symptom, not a verdict
    }
    if (!observedDid || observedDid === expectedDid) return false;

    // Both maps, at the same instant (D2). They are keyed the same way and
    // both say "these resources are in that KB"; voiding one would leave the
    // landing redirect pointing into a KB whose tabs were just cleared.
    this.mutateOpenResources(() => []);
    if (this.lastViewedByKb[kbId] !== undefined) {
      const { [kbId]: _dropped, ...rest } = this.lastViewedByKb;
      this.lastViewedByKb = rest;
      this.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, JSON.stringify(this.lastViewedByKb));
      this.refreshLastViewedResource();
    }

    // The registry entry itself is left exactly as the user wrote it (D4):
    // overwriting `did`/`label` would erase the only evidence a substitution
    // happened and sign them in to a KB they never chose under the name of one
    // they did. Re-registering is a deliberate act; the panel has that flow.
    this.activeSignals$.getValue()?.notifyKbIdentityConflict({ expectedDid, observedDid });
    return true;
  }

  /**
   * One tab's verdict.
   *
   * `.fresh()` is the one-shot read: it fetches, updates the store the viewer
   * reads from — so a validated tab is also a warmed cache entry (D5) — and
   * rejects on failure, which is the only way the verdict reaches us.
   *
   * Only `bus.not-found` removes (D2/D6). It is a verdict from the event
   * store, which is the system of record (D10); everything else is a symptom.
   */
  private async checkOpenResource(session: SemiontSession, id: string): Promise<TabCheck> {
    try {
      const descriptor = await session.client.browse.resource(resourceId(id)).fresh();
      const name = descriptor.name;
      const mediaType = getPrimaryRepresentation(descriptor)?.mediaType;
      return { kind: 'ready', name, ...(mediaType ? { mediaType } : {}) };
    } catch (error) {
      if (error instanceof BusRequestError && error.code === 'bus.not-found') {
        return { kind: 'gone' };
      }
      // Anything else: the tab stays. A transport fault is not a verdict.
      return { kind: 'unknown' };
    }
  }

  /**
   * All tab CRUD funnels through here: inert without an active, connected
   * KB (the projection gate), otherwise mutate that KB's list, persist the
   * whole map, and re-project.
   *
   * **Reads the COMMITTED map, not `this.openByKb`** (D11). The in-memory
   * copy is a projection cache — any sibling context's write may already have
   * outdated it — so mutating it and persisting was a plain lost update: two
   * windows each adding a tab silently lost one. `SessionStorage.get` is
   * synchronous, so read-modify-write costs a parse and closes it. It is also
   * what makes revalidation safe across contexts: a removal is written
   * against committed state, so a sibling's later add cannot resurrect it.
   *
   * The residual race is two processes interleaving inside one synchronous
   * tick; `localStorage` has no compare-and-swap, so nothing built on it can
   * close that.
   */
  private mutateOpenResources(mutate: (list: OpenResource[]) => OpenResource[]): void {
    const kbId = this.activeKbId$.getValue();
    if (!kbId || !this.activeSession$.getValue()) return;
    const committed = loadOpenResourcesByKb(this.storage);
    this.openByKb = { ...committed, [kbId]: mutate(committed[kbId] ?? []) };
    this.persistOpenResources();
    this.refreshOpenResources();
  }

  addOpenResource(
    id: string,
    name: string,
    mediaType?: string,
    storageUri?: string,
  ): void {
    this.mutateOpenResources((existing) => {
      const idx = existing.findIndex((r) => r.id === id);
      if (idx >= 0) {
        // Update metadata in place; keep position and openedAt.
        const prev = existing[idx]!;
        const updated: OpenResource = {
          ...prev,
          name,
          ...(mediaType !== undefined ? { mediaType } : {}),
          ...(storageUri !== undefined ? { storageUri } : {}),
        };
        const next = [...existing];
        next[idx] = updated;
        return next;
      }
      return [...existing, {
        id,
        name,
        openedAt: Date.now(),
        // max+1, not length: after removals, length can collide with a
        // surviving order (e.g. [0,2] + add), leaving placement to sort
        // stability.
        order: existing.reduce((m, r) => Math.max(m, r.order ?? -1), -1) + 1,
        ...(mediaType !== undefined ? { mediaType } : {}),
        ...(storageUri !== undefined ? { storageUri } : {}),
      }];
    });
  }

  removeOpenResource(id: string): void {
    this.mutateOpenResources((existing) => existing.filter((r) => r.id !== id));
  }

  updateOpenResourceName(id: string, name: string): void {
    this.mutateOpenResources((existing) =>
      existing.map((r) => (r.id === id ? { ...r, name } : r)),
    );
  }

  reorderOpenResources(oldIndex: number, newIndex: number): void {
    this.mutateOpenResources((existing) => {
      // Indices refer to the SORTED (visible) list; renumber `order` after
      // the move so the drag survives persistence and re-sorting.
      const list = sortOpenResources(existing);
      if (oldIndex < 0 || oldIndex >= list.length || newIndex < 0 || newIndex >= list.length) {
        return existing;
      }
      const [moved] = list.splice(oldIndex, 1);
      if (moved) list.splice(newIndex, 0, moved);
      return list.map((r, i) => ({ ...r, order: i }));
    });
  }

  // ── Last viewed resource (per-KB; the visible value is a projection) ──

  private refreshLastViewedResource(): void {
    const kbId = this.activeKbId$.getValue();
    const session = this.activeSession$.getValue();
    this.lastViewedResource$.next(kbId && session ? this.lastViewedByKb[kbId] ?? null : null);
  }

  /**
   * Record the resource the user is looking at, against the active KB.
   * Inert without an active, connected KB — the same gate the tabs use, so
   * a view that somehow renders during the activation gap cannot attribute
   * its resource to whichever KB happens to arrive next.
   */
  setLastViewedResource(resourceId: string): void {
    const kbId = this.activeKbId$.getValue();
    if (!kbId || !this.activeSession$.getValue()) return;
    if (this.lastViewedByKb[kbId] === resourceId) return;
    this.lastViewedByKb = { ...this.lastViewedByKb, [kbId]: resourceId };
    this.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, JSON.stringify(this.lastViewedByKb));
    this.refreshLastViewedResource();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.unsubscribeStorage) {
      this.unsubscribeStorage();
      this.unsubscribeStorage = null;
    }

    const prevSession = this.activeSession$.getValue();
    const prevSignals = this.activeSignals$.getValue();
    this.activeSession$.next(null);
    this.activeSignals$.next(null);
    if (prevSession) await prevSession.dispose();
    prevSignals?.dispose();

    this.kbs$.complete();
    this.activeKbId$.complete();
    this.activeSession$.complete();
    this.activeSignals$.complete();
    this.openResources$.complete();
    this.lastViewedResource$.complete();
    this.error$.complete();
    this.identityToken$.complete();
    this.eventBus.destroy();
  }
}
