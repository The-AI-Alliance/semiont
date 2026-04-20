/**
 * Small helpers so the session tests don't reach into the storage module
 * and can express intent directly.
 */

const PREFIX = 'semiont.session.';

export const SESSION_PREFIX_RE = new RegExp(`^${PREFIX.replace('.', '\\.')}`);

export function storageKey(kbId: string): string {
  return `${PREFIX}${kbId}`;
}

export function seedStoredSession(kbId: string, access: string, refresh: string): void {
  localStorage.setItem(storageKey(kbId), JSON.stringify({ access, refresh }));
}
