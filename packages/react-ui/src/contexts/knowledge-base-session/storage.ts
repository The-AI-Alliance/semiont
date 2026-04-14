/**
 * Pure helpers for the KnowledgeBaseSession provider.
 *
 * Contains:
 *  - localStorage shape and read/write helpers for KB list, active KB id,
 *    and per-KB sessions
 *  - JWT expiry parsing and "is expired" check
 *  - URL/protocol helpers for KB instances
 *  - The public `getKbSessionStatus(kbId)` helper that the KB-list UI uses
 *    to color status dots without subscribing to context changes
 *
 * No React imports, no module-scoped state, no side effects beyond
 * localStorage. Splitting these out of the provider file makes them
 * unit-testable in isolation and keeps the React provider focused on
 * lifecycle and state.
 */

import type { KnowledgeBase, KbSessionStatus } from '../../types/knowledge-base';

// ---------- Storage keys ----------

const SESSION_PREFIX = 'semiont.session.';
export const STORAGE_KEY = 'semiont.knowledgeBases';
export const ACTIVE_KEY = 'semiont.activeKnowledgeBaseId';

/** Refresh the access token this many milliseconds before it expires. */
export const REFRESH_BEFORE_EXP_MS = 5 * 60 * 1000;

/** The shape persisted to localStorage per KB. */
export interface StoredSession {
  access: string;
  refresh: string;
}

export function sessionKey(kbId: string): string {
  return `${SESSION_PREFIX}${kbId}`;
}

// ---------- Per-KB session storage ----------

export function getStoredSession(kbId: string): StoredSession | null {
  const raw = localStorage.getItem(sessionKey(kbId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.access === 'string' && typeof parsed.refresh === 'string') {
      return { access: parsed.access, refresh: parsed.refresh };
    }
  } catch {
    // malformed entry — treat as no session
  }
  return null;
}

export function setStoredSession(kbId: string, session: StoredSession): void {
  localStorage.setItem(sessionKey(kbId), JSON.stringify(session));
}

export function clearStoredSession(kbId: string): void {
  localStorage.removeItem(sessionKey(kbId));
}

// ---------- JWT helpers ----------

export function parseJwtExpiry(token: string): Date | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(atob(parts[1])) as { exp?: number };
    if (!payload.exp) return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

export function isJwtExpired(token: string): boolean {
  const expiry = parseJwtExpiry(token);
  if (!expiry) return true;
  return expiry.getTime() < Date.now();
}

// ---------- KB list storage ----------

function migrateLegacyEntry(entry: any): KnowledgeBase {
  if (entry.host !== undefined) return entry as KnowledgeBase;
  // Legacy format: { id, label, backendUrl }
  try {
    const url = new URL(entry.backendUrl);
    return {
      id: entry.id,
      label: entry.label,
      host: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol === 'https:' ? 'https' : 'http',
      email: '',
    };
  } catch {
    return {
      id: entry.id,
      label: entry.label || 'Unknown',
      host: 'localhost',
      port: 4000,
      protocol: 'http',
      email: '',
    };
  }
}

export function loadKnowledgeBases(): KnowledgeBase[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const entries = JSON.parse(raw) as any[];
    return entries.map(migrateLegacyEntry);
  } catch {
    return [];
  }
}

export function saveKnowledgeBases(knowledgeBases: KnowledgeBase[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(knowledgeBases));
}

// ---------- Public pure helpers ----------

export function defaultProtocol(host: string): 'http' | 'https' {
  return host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https';
}

/** Accepts: localhost, dotted-decimal IPv4, valid DNS labels. Rejects slashes, colons, query strings. */
const HOSTNAME_RE = /^(([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?|localhost|\d{1,3}(\.\d{1,3}){3})$/;

export function isValidHostname(host: string): boolean {
  return HOSTNAME_RE.test(host);
}

export function kbBackendUrl(kb: KnowledgeBase): string {
  if (!isValidHostname(kb.host)) {
    throw new Error(`Invalid KB hostname: "${kb.host}"`);
  }
  // Use URL property assignment so the parser normalises the hostname (e.g. lowercasing)
  // rather than blindly interpolating a user-supplied string.
  const url = new URL('http://x');
  url.protocol = kb.protocol + ':';
  url.hostname = kb.host;
  url.port = String(kb.port);
  return `${kb.protocol}://${url.hostname}:${kb.port}`;
}

/**
 * Read the locally-stored credential status for a KB. Pure / synchronous —
 * does not subscribe to context changes. Used by KB-list UI to color status
 * dots without requiring re-renders on every tick.
 */
export function getKbSessionStatus(kbId: string): KbSessionStatus {
  const stored = getStoredSession(kbId);
  if (!stored) return 'signed-out';
  return isJwtExpired(stored.access) ? 'expired' : 'authenticated';
}

export function generateKbId(): string {
  return crypto.randomUUID();
}
