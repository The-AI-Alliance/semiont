/**
 * Pure helpers and storage-adapter-driven loaders for the Semiont
 * session layer.
 *
 * Contains:
 *  - Storage key shape (constants, `sessionKey(kbId)`)
 *  - JWT expiry parsing and "is expired" check
 *  - URL/protocol helpers for KB instances
 *  - Loaders/savers that take a `SessionStorage` and operate over it
 *    (no direct `localStorage` access)
 *
 * No React imports, no module-scoped state, no side effects beyond
 * whatever the passed-in `SessionStorage` does.
 */

import { uuidV4 } from '@semiont/core';

import type { HttpEndpoint, KnowledgeBase } from './knowledge-base';
import type { SessionStorage } from './session-storage';

// ---------- Storage keys ----------

const SESSION_PREFIX = 'semiont.session.';
export const STORAGE_KEY = 'semiont.knowledgeBases';
export const ACTIVE_KEY = 'semiont.activeKnowledgeBaseId';
/** Per-KB open-resource tabs: Record<kbId, OpenResource[]>. */
export const OPEN_RESOURCES_BY_KB_KEY = 'semiont.openResourcesByKb';
/**
 * Per-KB "where was I": Record<kbId, resourceId>. Scoped like the tabs it
 * sits beside — a global last-viewed id sends the landing redirect into the
 * previously active KB's resource, which the new gateway 404s.
 */
export const LAST_VIEWED_RESOURCE_BY_KB_KEY = 'semiont.lastViewedResourceByKb';

/** Refresh the access token this many milliseconds before it expires. */
export const REFRESH_BEFORE_EXP_MS = 5 * 60 * 1000;

/** The shape persisted per KB. */
export interface StoredSession {
  access: string;
  refresh: string;
}

export function sessionKey(kbId: string): string {
  return `${SESSION_PREFIX}${kbId}`;
}

// ---------- Per-KB session storage ----------

export function getStoredSession(storage: SessionStorage, kbId: string): StoredSession | null {
  const raw = storage.get(sessionKey(kbId));
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

export function setStoredSession(storage: SessionStorage, kbId: string, session: StoredSession): void {
  storage.set(sessionKey(kbId), JSON.stringify(session));
}

export function clearStoredSession(storage: SessionStorage, kbId: string): void {
  storage.delete(sessionKey(kbId));
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

function isKnowledgeBase(entry: unknown): entry is KnowledgeBase {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.label !== 'string' || typeof e.email !== 'string') {
    return false;
  }
  // `did` is required (KB-IDENTITY-VS-ADDRESS decision 8). Entries persisted
  // before that rule have none, and without this check they would load and
  // violate the type at runtime — the identity join would then compare
  // against `undefined` and silently never match, which is the failure mode
  // that plan exists to end. Per the storage stance (no back-compat layer),
  // they drop and the user re-adds; the cost is a one-time list clear, paid
  // once, in exchange for every loaded KB actually having the identity its
  // type promises.
  if (typeof e.did !== 'string') return false;
  const ep = e.endpoint as Record<string, unknown> | undefined;
  if (!ep || typeof ep !== 'object') return false;
  if (ep.kind === 'http') {
    return typeof ep.host === 'string'
      && typeof ep.port === 'number'
      && (ep.protocol === 'http' || ep.protocol === 'https');
  }
  if (ep.kind === 'local') {
    return typeof ep.kbId === 'string';
  }
  return false;
}

/**
 * Load the persisted KB list. Entries that don't conform to the current
 * `KnowledgeBase` shape are dropped silently — the storage format has no
 * back-compat layer (the project's stance on storage migrations: change
 * the shape directly, no legacy fallbacks). Stale entries vanish; the
 * user re-adds the affected KBs.
 */
export function loadKnowledgeBases(storage: SessionStorage): KnowledgeBase[] {
  try {
    const raw = storage.get(STORAGE_KEY);
    if (!raw) return [];
    const entries = JSON.parse(raw) as unknown[];
    return entries.filter(isKnowledgeBase);
  } catch {
    return [];
  }
}

export function saveKnowledgeBases(storage: SessionStorage, knowledgeBases: KnowledgeBase[]): void {
  storage.set(STORAGE_KEY, JSON.stringify(knowledgeBases));
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

/**
 * Build the wire URL for an HTTP KB endpoint. HTTP-shaped helper —
 * lives next to the KB list machinery because the frontend Panel needs
 * it for the auth round-trip when adding a KB. Code that holds a
 * uniform `KnowledgeBase` should not call this; it should hand the KB
 * to a transport factory and let the factory inspect `endpoint.kind`.
 */
export function kbGatewayUrl(endpoint: HttpEndpoint): string {
  if (!isValidHostname(endpoint.host)) {
    throw new Error(`Invalid KB hostname: "${endpoint.host}"`);
  }
  // Use URL property assignment so the parser normalises the hostname (e.g. lowercasing)
  // rather than blindly interpolating a user-supplied string.
  const url = new URL('http://x');
  url.protocol = endpoint.protocol + ':';
  url.hostname = endpoint.host;
  url.port = String(endpoint.port);
  return `${endpoint.protocol}://${url.hostname}:${endpoint.port}`;
}

export function generateKbId(): string {
  return uuidV4();
}
