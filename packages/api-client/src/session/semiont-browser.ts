/**
 * SemiontBrowser — top-level app-facing container for non-KB state.
 *
 * Holds the list of configured KBs, the active KB selection, the active
 * SemiontSession, the identity token, the open-resources list, and a
 * session-level error stream. Module-scoped singleton — survives every
 * React re-render, remount, and route change. `SemiontProvider` hands
 * the singleton to the React tree; `useSemiont()` returns it.
 *
 * Persistence goes through a `SessionStorage` adapter provided at
 * construction — the browser never touches `localStorage` or `window`
 * directly.
 */

import { BehaviorSubject, Subject, type Observable } from 'rxjs';
import { EventBus, type EventMap } from '@semiont/core';
import {
  ACTIVE_KEY,
  clearStoredSession,
  generateKbId,
  getStoredSession,
  isJwtExpired,
  loadKnowledgeBases,
  saveKnowledgeBases,
  setStoredSession,
} from './storage';
import { registerAuthNotifyHandlers } from './notify';
import type { KnowledgeBase, KbSessionStatus, NewKnowledgeBase } from './knowledge-base';
import type { OpenResource } from './open-resource';
import { SemiontSession } from './semiont-session';
import { SemiontError } from './errors';
import type { SessionStorage } from './session-storage';

const OPEN_RESOURCES_KEY = 'openDocuments';

function sortOpenResources(resources: OpenResource[]): OpenResource[] {
  return [...resources].sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    return a.openedAt - b.openedAt;
  });
}

function loadOpenResources(storage: SessionStorage): OpenResource[] {
  try {
    const stored = storage.get(OPEN_RESOURCES_KEY);
    if (stored) return sortOpenResources(JSON.parse(stored) as OpenResource[]);
  } catch {
    // Ignore parse errors
  }
  return [];
}

export interface SemiontBrowserConfig {
  /** Persistence adapter. The browser reads/writes all persisted state via this. */
  storage: SessionStorage;
}

export class SemiontBrowser {
  readonly kbs$: BehaviorSubject<KnowledgeBase[]>;
  readonly activeKbId$: BehaviorSubject<string | null>;
  readonly activeSession$: BehaviorSubject<SemiontSession | null>;
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
  readonly error$: Subject<SemiontError>;
  readonly identityToken$: BehaviorSubject<string | null>;

  private readonly storage: SessionStorage;
  /**
   * App-scoped EventBus. Hosts UI-shell events that must work regardless
   * of whether a KB session is active: panel toggles, sidebar state,
   * tab reorders, routing, settings, etc. Disjoint from the per-session
   * bus inside `SemiontApiClient`, which carries KB-content events
   * (mark:*, beckon:*, gather:*, match:*, bind:*, yield:*, browse:click).
   */
  private readonly eventBus: EventBus = new EventBus();
  private unregisterNotify: (() => void) | null = null;
  private unsubscribeStorage: (() => void) | null = null;
  private disposed = false;
  private activating: Promise<void> | null = null;

  constructor(config: SemiontBrowserConfig) {
    this.storage = config.storage;

    const kbs = loadKnowledgeBases(this.storage);
    const storedActive = this.storage.get(ACTIVE_KEY);
    const initialActive =
      storedActive && kbs.some((kb) => kb.id === storedActive)
        ? storedActive
        : kbs[0]?.id ?? null;

    this.kbs$ = new BehaviorSubject<KnowledgeBase[]>(kbs);
    this.activeKbId$ = new BehaviorSubject<string | null>(initialActive);
    this.activeSession$ = new BehaviorSubject<SemiontSession | null>(null);
    this.sessionActivating$ = new BehaviorSubject<boolean>(false);
    this.openResources$ = new BehaviorSubject<OpenResource[]>(loadOpenResources(this.storage));
    this.error$ = new Subject<SemiontError>();
    this.identityToken$ = new BehaviorSubject<string | null>(null);

    // Persist kbs$ and activeKbId$ via the storage adapter.
    this.kbs$.subscribe((next) => saveKnowledgeBases(this.storage, next));
    this.activeKbId$.subscribe((id) => {
      if (id) this.storage.set(ACTIVE_KEY, id);
      else this.storage.delete(ACTIVE_KEY);
    });

    // Persist openResources$ on every change.
    this.openResources$.subscribe((list) => {
      this.storage.set(OPEN_RESOURCES_KEY, JSON.stringify(list));
    });

    // Sync openResources$ from other contexts (cross-tab/cross-process).
    this.unsubscribeStorage = this.storage.subscribe?.((key, newValue) => {
      if (key !== OPEN_RESOURCES_KEY || !newValue) return;
      try {
        this.openResources$.next(sortOpenResources(JSON.parse(newValue) as OpenResource[]));
      } catch {
        // Ignore parse errors
      }
    }) ?? null;

    // Route notify-module calls (from outside-React code paths like the
    // React Query QueryCache.onError handler) into the active session's
    // modal state.
    this.unregisterNotify = registerAuthNotifyHandlers({
      onSessionExpired: (message) => {
        this.activeSession$.getValue()?.notifySessionExpired(message ?? null);
      },
      onPermissionDenied: (message) => {
        this.activeSession$.getValue()?.notifyPermissionDenied(message ?? null);
      },
    });

    // Construct the initial active session, if any. Fire-and-forget.
    if (initialActive) {
      void this.setActiveKb(initialActive);
    }
  }

  // ── App-scoped event bus ──────────────────────────────────────────────

  /** Emit an event on the browser's app-scoped bus. */
  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
    if (this.disposed) return;
    this.eventBus.get(channel).next(payload);
  }

  /** Subscribe to an event; returns unsubscribe. */
  on<K extends keyof EventMap>(
    channel: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    const sub = this.eventBus.get(channel).subscribe(handler);
    return () => sub.unsubscribe();
  }

  /** Read-only observable for an app-scoped channel. */
  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.eventBus.get(channel).asObservable();
  }

  // ── Identity token (NextAuth bridge; D1) ──────────────────────────────

  /**
   * Set the app-level identity token (from NextAuth's useSession).
   * Called at the root layout via a single `useEffect`. No other site
   * in the codebase should call this.
   */
  setIdentityToken(token: string | null): void {
    if (this.disposed) return;
    this.identityToken$.next(token);
  }

  // ── KB list management ────────────────────────────────────────────────

  addKb(input: NewKnowledgeBase, access: string, refresh: string): KnowledgeBase {
    const kb: KnowledgeBase = { id: generateKbId(), ...input };
    setStoredSession(this.storage, kb.id, { access, refresh });
    this.kbs$.next([...this.kbs$.getValue(), kb]);
    void this.setActiveKb(kb.id);
    return kb;
  }

  removeKb(id: string): void {
    clearStoredSession(this.storage, id);
    const next = this.kbs$.getValue().filter((kb) => kb.id !== id);
    this.kbs$.next(next);
    if (this.activeKbId$.getValue() === id) {
      void this.setActiveKb(next[0]?.id ?? null);
    }
  }

  updateKb(id: string, updates: Partial<KnowledgeBase>): void {
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
    // detect staleness.
    if (prevId !== id) this.activeKbId$.next(id);
    if (prevSession) this.activeSession$.next(null);

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
      if (toDispose) {
        this.activeSession$.next(null);
        await toDispose.dispose();
      }

      if (!id) return;

      const kb = this.kbs$.getValue().find((k) => k.id === id);
      if (!kb) return;

      const session = new SemiontSession({
        kb,
        storage: this.storage,
        onError: (err) => this.error$.next(err),
      });

      try {
        await session.ready;
      } catch (err) {
        this.error$.next(
          new SemiontError(
            'session.construct-failed',
            err instanceof Error ? err.message : String(err),
            id,
          ),
        );
        await session.dispose();
        return;
      }

      if (this.disposed || this.activeKbId$.getValue() !== id) {
        await session.dispose();
        return;
      }

      this.activeSession$.next(session);
    })();

    this.activating = activation;
    this.sessionActivating$.next(true);
    try {
      await activation;
    } finally {
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
  async signIn(id: string, access: string, refresh: string): Promise<void> {
    if (this.disposed) return;
    setStoredSession(this.storage, id, { access, refresh });

    // If this KB is already active, tear down and reconstruct so the new
    // tokens are picked up from storage by the session ctor.
    if (this.activeKbId$.getValue() === id) {
      const prev = this.activeSession$.getValue();
      this.activeSession$.next(null);
      if (prev) await prev.dispose();
      await this.setActiveKb(id);
      return;
    }

    await this.setActiveKb(id);
  }

  /**
   * Sign out of a KB: clear stored tokens. If the KB is active, dispose
   * its session and emit null for `activeSession$`.
   */
  async signOut(id: string): Promise<void> {
    if (this.disposed) return;
    clearStoredSession(this.storage, id);

    // Bump the kbs$ list so downstream status-derivations re-run.
    this.kbs$.next([...this.kbs$.getValue()]);

    if (this.activeKbId$.getValue() === id) {
      const prev = this.activeSession$.getValue();
      this.activeSession$.next(null);
      if (prev) await prev.dispose();
    }
  }

  // ── Open resources ────────────────────────────────────────────────────

  addOpenResource(
    id: string,
    name: string,
    mediaType?: string,
    storageUri?: string,
  ): void {
    const existing = this.openResources$.getValue();
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
      this.openResources$.next(next);
      return;
    }
    const resource: OpenResource = {
      id,
      name,
      openedAt: Date.now(),
      order: existing.length,
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...(storageUri !== undefined ? { storageUri } : {}),
    };
    this.openResources$.next([...existing, resource]);
  }

  removeOpenResource(id: string): void {
    this.openResources$.next(this.openResources$.getValue().filter((r) => r.id !== id));
  }

  updateOpenResourceName(id: string, name: string): void {
    this.openResources$.next(
      this.openResources$.getValue().map((r) => (r.id === id ? { ...r, name } : r)),
    );
  }

  reorderOpenResources(oldIndex: number, newIndex: number): void {
    const list = [...this.openResources$.getValue()];
    if (oldIndex < 0 || oldIndex >= list.length || newIndex < 0 || newIndex >= list.length) {
      return;
    }
    const [moved] = list.splice(oldIndex, 1);
    if (moved) list.splice(newIndex, 0, moved);
    this.openResources$.next(list);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.unregisterNotify?.();
    this.unregisterNotify = null;

    if (this.unsubscribeStorage) {
      this.unsubscribeStorage();
      this.unsubscribeStorage = null;
    }

    const prev = this.activeSession$.getValue();
    this.activeSession$.next(null);
    if (prev) await prev.dispose();

    this.kbs$.complete();
    this.activeKbId$.complete();
    this.activeSession$.complete();
    this.openResources$.complete();
    this.error$.complete();
    this.identityToken$.complete();
    this.eventBus.destroy();
  }
}
