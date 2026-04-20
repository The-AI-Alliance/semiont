/**
 * SemiontBrowser — top-level app-facing container for non-KB state.
 *
 * Holds the list of configured KBs, the active KB selection, the active
 * SemiontSession, the NextAuth identity token, the open-resources list,
 * and a session-level error stream. Module-scoped singleton — survives
 * every React re-render, remount, and route change.
 *
 * Replaces the app-level responsibilities of KnowledgeBaseSessionProvider
 * and the old OpenResources context.
 */

import { BehaviorSubject, Subject } from 'rxjs';
import {
  ACTIVE_KEY,
  clearStoredSession,
  generateKbId,
  loadKnowledgeBases,
  saveKnowledgeBases,
  setStoredSession,
} from './storage';
import { registerAuthNotifyHandlers } from './notify';
import type { KnowledgeBase, NewKnowledgeBase } from '../types/knowledge-base';
import type { OpenResource } from '../types/OpenResourcesManager';
import { SemiontSession } from './semiont-session';
import { SemiontError } from './errors';

const OPEN_RESOURCES_KEY = 'openDocuments';

function sortOpenResources(resources: OpenResource[]): OpenResource[] {
  return [...resources].sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    return a.openedAt - b.openedAt;
  });
}

function loadOpenResources(): OpenResource[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(OPEN_RESOURCES_KEY);
    if (stored) return sortOpenResources(JSON.parse(stored) as OpenResource[]);
  } catch {
    // Ignore parse errors
  }
  return [];
}

export class SemiontBrowser {
  readonly kbs$: BehaviorSubject<KnowledgeBase[]>;
  readonly activeKbId$: BehaviorSubject<string | null>;
  readonly activeSession$: BehaviorSubject<SemiontSession | null>;
  readonly openResources$: BehaviorSubject<OpenResource[]>;
  readonly error$: Subject<SemiontError>;
  readonly identityToken$: BehaviorSubject<string | null>;

  private unregisterNotify: (() => void) | null = null;
  private disposed = false;
  private activating: Promise<void> | null = null;
  private readonly handleOpenResourcesStorageEvent: (e: StorageEvent) => void;

  constructor() {
    const kbs = loadKnowledgeBases();
    const storedActive =
      typeof window !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null;
    const initialActive =
      storedActive && kbs.some((kb) => kb.id === storedActive)
        ? storedActive
        : kbs[0]?.id ?? null;

    this.kbs$ = new BehaviorSubject<KnowledgeBase[]>(kbs);
    this.activeKbId$ = new BehaviorSubject<string | null>(initialActive);
    this.activeSession$ = new BehaviorSubject<SemiontSession | null>(null);
    this.openResources$ = new BehaviorSubject<OpenResource[]>(loadOpenResources());
    this.error$ = new Subject<SemiontError>();
    this.identityToken$ = new BehaviorSubject<string | null>(null);

    // Persist kbs$ and activeKbId$ to localStorage.
    this.kbs$.subscribe((next) => {
      if (typeof window !== 'undefined') saveKnowledgeBases(next);
    });
    this.activeKbId$.subscribe((id) => {
      if (typeof window === 'undefined') return;
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    });

    // Persist openResources$ to localStorage on every change.
    this.openResources$.subscribe((list) => {
      if (typeof window !== 'undefined') {
        localStorage.setItem(OPEN_RESOURCES_KEY, JSON.stringify(list));
      }
    });

    // Sync openResources$ from other tabs via StorageEvent.
    this.handleOpenResourcesStorageEvent = (e: StorageEvent): void => {
      if (e.key === OPEN_RESOURCES_KEY && e.newValue) {
        try {
          this.openResources$.next(sortOpenResources(JSON.parse(e.newValue) as OpenResource[]));
        } catch {
          // Ignore parse errors
        }
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleOpenResourcesStorageEvent);
    }

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
    setStoredSession(kb.id, { access, refresh });
    this.kbs$.next([...this.kbs$.getValue(), kb]);
    void this.setActiveKb(kb.id);
    return kb;
  }

  removeKb(id: string): void {
    clearStoredSession(id);
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
    try {
      await activation;
    } finally {
      if (this.activating === activation) this.activating = null;
    }
  }

  /**
   * Sign in to an existing KB: store the tokens and (re)activate the
   * session. If the KB is already active, the current session is disposed
   * and replaced so the new tokens take effect.
   */
  async signIn(id: string, access: string, refresh: string): Promise<void> {
    if (this.disposed) return;
    setStoredSession(id, { access, refresh });

    // If this KB is already active, tear down and reconstruct so the new
    // tokens are picked up from localStorage by the session ctor.
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
    clearStoredSession(id);

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

    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleOpenResourcesStorageEvent);
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
  }
}
