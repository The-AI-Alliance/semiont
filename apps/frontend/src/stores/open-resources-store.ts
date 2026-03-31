/**
 * OpenResourcesStore — per-workspace observable store for open resources
 *
 * BehaviorSubject-backed store for the list of open documents (tabs).
 * Replaces useState in useOpenResourcesManager with a reactive store that:
 * - Persists to localStorage
 * - Syncs across tabs via StorageEvent
 */

import { BehaviorSubject, Observable } from 'rxjs';
import type { OpenResource } from '@semiont/react-ui';

const STORAGE_KEY = 'openDocuments';

function sortResources(resources: OpenResource[]): OpenResource[] {
  return [...resources].sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    return a.openedAt - b.openedAt;
  });
}

function loadFromStorage(): OpenResource[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return sortResources(JSON.parse(stored) as OpenResource[]);
  } catch {
    // Ignore parse errors
  }
  return [];
}

export class OpenResourcesStore {
  private readonly state$ = new BehaviorSubject<OpenResource[]>(loadFromStorage());

  /** Observable of the current open resources list */
  readonly resources$: Observable<OpenResource[]> = this.state$.asObservable();

  constructor() {
    // Persist to localStorage on every change
    this.state$.subscribe(resources => {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(resources));
      }
    });

    // Sync from other tabs
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorageEvent);
    }
  }

  private readonly handleStorageEvent = (e: StorageEvent): void => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try {
        this.state$.next(sortResources(JSON.parse(e.newValue) as OpenResource[]));
      } catch {
        // Ignore parse errors
      }
    }
  };

  get resources(): OpenResource[] {
    return this.state$.value;
  }

  add(id: string, name: string, mediaType?: string, storageUri?: string): void {
    const current = this.state$.value;
    const existing = current.find(r => r.id === id);
    if (existing) {
      this.state$.next(current.map(r =>
        r.id === id
          ? { ...r, name, ...(mediaType && { mediaType }), ...(storageUri && { storageUri }) }
          : r
      ));
    } else {
      const maxOrder = current.length > 0
        ? Math.max(...current.map(r => r.order ?? r.openedAt))
        : 0;
      this.state$.next([
        ...current,
        { id, name, openedAt: Date.now(), order: maxOrder + 1, ...(mediaType && { mediaType }), ...(storageUri && { storageUri }) },
      ]);
    }
  }

  remove(id: string): void {
    this.state$.next(this.state$.value.filter(r => r.id !== id));
  }

  updateName(id: string, name: string): void {
    this.state$.next(this.state$.value.map(r => r.id === id ? { ...r, name } : r));
  }

  reorder(oldIndex: number, newIndex: number): void {
    const current = [...this.state$.value];
    const moved = current.splice(oldIndex, 1)[0]!;
    current.splice(newIndex, 0, moved);
    this.state$.next(current.map((r, index) => ({ ...r, order: index })));
  }

  /** Release event listener — call when the workspace is torn down */
  destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorageEvent);
    }
  }
}
