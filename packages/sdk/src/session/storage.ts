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

import { isObject, isString, uuidV4 } from '@semiont/core';

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

/**
 * The LARGEST margin the proactive refresh will use. A ceiling, not the
 * margin itself — see {@link refreshDelayMs}, which shrinks it to fit the
 * token when the token is short-lived.
 *
 * It was the margin outright until 2026-09-23, and that was correct for as
 * long as this client's tokens came from a gateway minting hour-long ones.
 * Keycloak's default `accessTokenLifespan` is also exactly five minutes, so
 * `exp - margin` landed on `iat` — always in the past, so the delay was always
 * zero and each refresh scheduled the next immediately. An idle signed-in page
 * issued 1418 successful `POST /token` in ten seconds.
 */
export const REFRESH_BEFORE_EXP_MS = 5 * 60 * 1000;

/**
 * The shortest the proactive refresh will ever wait.
 *
 * `Math.max(0, …)` permitted a timer scheduled for "now" that rescheduled
 * itself on arrival — a closed loop at whatever rate the event loop allowed.
 * A floor makes that structurally impossible rather than merely unlikely: even
 * an issuer minting already-expired tokens gets one attempt per interval, not
 * a storm. Ten seconds because this timer is an optimisation, never the last
 * line of defence — a 401 still drives a reactive refresh — so waiting is
 * cheap and spinning is not.
 */
export const MIN_REFRESH_DELAY_MS = 10 * 1000;

/**
 * How long to wait before proactively refreshing `token`, or `null` when it
 * carries no `exp` to schedule against (the caller then schedules nothing).
 *
 * **The margin is a fraction of the token's OWN lifetime**, capped at
 * {@link REFRESH_BEFORE_EXP_MS}. That is the whole fix: a constant margin can
 * equal — or exceed — the lifetime of a token some issuer mints, and when it
 * does, the subtraction yields a moment already past. Half the lifetime cannot,
 * for any lifetime, so no issuer's configuration can reproduce the loop. This
 * matters beyond the realm Semiont runs: for `type = "oidc"` the launcher
 * deliberately refuses to set a lifespan at all, so an external issuer's
 * lifetime is not ours to correct and the client is the only place that can be
 * right for every issuer.
 */
export function refreshDelayMs(token: string, now: number = Date.now()): number | null {
  const claims = parseJwtClaims(token);
  if (!claims?.exp) return null;

  const expMs = claims.exp * 1000;
  // `exp - iat` is the lifetime the issuer chose. Without `iat` — not every
  // issuer sends one — the remaining life is the only lifetime observable,
  // and halving that is bounded too, which is the property that matters.
  const lifetimeMs = claims.iat ? (claims.exp - claims.iat) * 1000 : expMs - now;
  const marginMs = Math.min(REFRESH_BEFORE_EXP_MS, Math.max(0, lifetimeMs) / 2);

  return Math.max(MIN_REFRESH_DELAY_MS, expMs - marginMs - now);
}

/** The two claims scheduling depends on. Absent or unreadable reads as null. */
function parseJwtClaims(token: string): { exp?: number; iat?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    return JSON.parse(atob(parts[1])) as { exp?: number; iat?: number };
  } catch {
    return null;
  }
}

/**
 * The shape persisted per KB: the tokens an issuer issued, the client they
 * were issued to, and the issuer endpoints a renewal and a sign-out need —
 * discovered once at sign-in, so no session re-asks.
 */
export interface StoredSession {
  access: string;
  refresh: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

export function sessionKey(kbId: string): string {
  return `${SESSION_PREFIX}${kbId}`;
}

// ---------- Per-KB session storage ----------

export function getStoredSession(storage: SessionStorage, kbId: string): StoredSession | null {
  const raw = storage.get(sessionKey(kbId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isObject(parsed)
      && isString(parsed['access']) && isString(parsed['refresh'])
      && isString(parsed['clientId']) && isString(parsed['tokenEndpoint'])
    ) {
      return {
        access: parsed['access'],
        refresh: parsed['refresh'],
        clientId: parsed['clientId'],
        tokenEndpoint: parsed['tokenEndpoint'],
        ...(isString(parsed['revocationEndpoint']) ? { revocationEndpoint: parsed['revocationEndpoint'] } : {}),
      };
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
  const exp = parseJwtClaims(token)?.exp;
  return exp ? new Date(exp * 1000) : null;
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
  if (typeof e.id !== 'string' || typeof e.label !== 'string') {
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
    // PROJECTED, not passed through. A guard proves the known fields are
    // there; it says nothing about what else a record written by an older
    // release carries, and a spread of one of those (`{ ...existing }`) would
    // carry the extra straight back out. `email` was such a field — a copy of
    // whoever last signed in, which then surfaced under a KB card as the
    // account someone was about to sign in AS.
    return entries.filter(isKnowledgeBase).map((e) => ({
      id: e.id,
      label: e.label,
      did: e.did,
      endpoint: e.endpoint,
      ...(e.gitBranch !== undefined ? { gitBranch: e.gitBranch } : {}),
    }));
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
