/**
 * The session layer as an OAuth public client against the issuer a knowledge
 * base trusts: issuer discovery from the KB's resource metadata (RFC 9728),
 * the authorization-code grant with PKCE (RFC 7636) for a browser, the
 * device authorization grant (RFC 8628) for a script, the refresh grant, and
 * token revocation (RFC 7009). Plain fetch against the issuer; nothing here
 * names a vendor, and no password ever passes through this module.
 */

import { APIError, HttpTransport } from '@semiont/http-transport';
import {
  RETRY_RULES,
  baseUrl,
  isObject,
  isString,
  retryWithBackoff,
  type RetryPolicy,
} from '@semiont/core';
import type { HttpEndpoint } from './knowledge-base';
import type { SessionStorage } from './session-storage';
import { getStoredSession, kbGatewayUrl, setStoredSession } from './storage';

/** The Browser's registration at every issuer: authorization code with PKCE. */
export const BROWSER_CLIENT_ID = 'semiont-browser';
/** A script's registration: the device grant — the same client the launcher uses. */
export const SCRIPT_CLIENT_ID = 'semiont-cli';
export const PENDING_AUTHORIZATION_KEY = 'semiont.pendingAuthorization';
// offline_access asks for a refresh token that outlives the issuer's own
// browser session — a KB session is renewed for weeks, not minutes.
const SCOPE = 'openid email profile offline_access';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export type SignInErrorCode =
  | 'no-issuer'
  | 'discovery'
  | 'no-pending'
  | 'state'
  | 'denied'
  | 'expired'
  | 'aborted'
  | 'exchange';

export class SignInError extends Error {
  /**
   * The HTTP status the issuer answered with, when there was one.
   *
   * Absent means no response existed to read — `fetch` threw. That difference
   * is the whole of REFRESH-FAILURE-TRANSIENT-VS-TERMINAL: an issuer refusing
   * a grant and a network losing a packet are not the same event, and until
   * this field existed the status was read to build the message and then
   * dropped, leaving the two indistinguishable one layer up.
   */
  constructor(readonly code: SignInErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'SignInError';
  }
}

export interface IssuerEndpoints {
  issuer: string;
  authorization: string;
  token: string;
  device?: string;
  revocation?: string;
}

/**
 * The knowledge base names its issuer (resource metadata); the issuer names
 * its endpoints (OpenID discovery). A client that knows a gateway's address
 * knows everything — no configuration on this side.
 */
export async function discoverIssuer(target: HttpEndpoint): Promise<IssuerEndpoints> {
  const transport = new HttpTransport({ baseUrl: baseUrl(kbGatewayUrl(target)) });
  let issuer: string;
  try {
    const metadata = await transport.getProtectedResourceMetadata();
    const [first] = metadata.authorization_servers;
    if (!first) throw new SignInError('no-issuer', 'The knowledge base trusts no external issuer');
    issuer = first;
  } catch (err) {
    if (err instanceof SignInError) throw err;
    if (err instanceof APIError && err.status === 404) {
      throw new SignInError('no-issuer', 'The knowledge base trusts no external issuer');
    }
    throw new SignInError(
      'discovery',
      `The knowledge base did not answer its resource metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    transport.dispose();
  }

  const response = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new SignInError('discovery', `Issuer ${issuer}: discovery answered HTTP ${response.status}`);
  }
  const doc: unknown = await response.json();
  if (
    !isObject(doc)
    || doc['issuer'] !== issuer
    || !isString(doc['authorization_endpoint'])
    || !isString(doc['token_endpoint'])
  ) {
    throw new SignInError('discovery', `Issuer ${issuer}: its discovery document is not an OpenID configuration for it`);
  }
  return {
    issuer,
    authorization: doc['authorization_endpoint'],
    token: doc['token_endpoint'],
    ...(isString(doc['device_authorization_endpoint']) ? { device: doc['device_authorization_endpoint'] } : {}),
    ...(isString(doc['revocation_endpoint']) ? { revocation: doc['revocation_endpoint'] } : {}),
  };
}

// ---------- PKCE ----------

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlSafe(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

/** RFC 7636 §4.2: BASE64URL(SHA-256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ---------- Authorization code with PKCE (a browser) ----------

/**
 * Everything a sign-in must remember across the redirect to the issuer and
 * back: the PKCE verifier and state the response must match, where the user
 * was connecting, what they believed they were connecting to, and the
 * issuer's endpoints so the completion asks nothing twice.
 */
export interface PendingAuthorization {
  state: string;
  verifier: string;
  redirectUri: string;
  target: HttpEndpoint;
  issuer: IssuerEndpoints;
  kbId?: string;
  expectedDid?: string;
  expectedName?: string;
}

export interface BeginAuthorizationOptions {
  target: HttpEndpoint;
  redirectUri: string;
  /** Re-authenticating a registered KB, rather than connecting to a new address. */
  kbId?: string;
  /** What the user believed they clicked (a discovered row) — verified after, never assumed. */
  expectedDid?: string;
  expectedName?: string;
}

/**
 * Start the authorization-code grant: discover the issuer, remember the
 * pending sign-in, and return the URL the host navigates the user to.
 */
export async function beginAuthorization(opts: BeginAuthorizationOptions, pending: SessionStorage): Promise<string> {
  const issuer = await discoverIssuer(opts.target);
  const verifier = randomUrlSafe(48);
  const state = randomUrlSafe(24);
  const record: PendingAuthorization = {
    state,
    verifier,
    redirectUri: opts.redirectUri,
    target: opts.target,
    issuer,
    ...(opts.kbId ? { kbId: opts.kbId } : {}),
    ...(opts.expectedDid ? { expectedDid: opts.expectedDid } : {}),
    ...(opts.expectedName ? { expectedName: opts.expectedName } : {}),
  };
  pending.set(PENDING_AUTHORIZATION_KEY, JSON.stringify(record));
  const url = new URL(issuer.authorization);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', BROWSER_CLIENT_ID);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await codeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface IssuedTokens {
  access: string;
  refresh: string;
}

/**
 * Finish the authorization-code grant from the URL the issuer sent the user
 * back to. One-shot: the pending record is consumed before anything else
 * happens, because an authorization code is single-use and a replayed
 * callback must find nothing to complete.
 */
export async function completeAuthorization(
  callbackUrl: string,
  pending: SessionStorage,
): Promise<{ pending: PendingAuthorization; tokens: IssuedTokens }> {
  const raw = pending.get(PENDING_AUTHORIZATION_KEY);
  pending.delete(PENDING_AUTHORIZATION_KEY);
  const record = raw === null ? null : parsePending(raw);
  if (!record) throw new SignInError('no-pending', 'No sign-in is pending here');

  const url = new URL(callbackUrl);
  const error = url.searchParams.get('error');
  if (error) {
    throw new SignInError(
      error === 'access_denied' ? 'denied' : 'exchange',
      url.searchParams.get('error_description') ?? error,
    );
  }
  if (url.searchParams.get('state') !== record.state) {
    throw new SignInError('state', 'The sign-in response does not belong to the pending sign-in');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new SignInError('exchange', 'The sign-in response carries no authorization code');

  const tokens = await tokenGrant(record.issuer.token, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: record.redirectUri,
    client_id: BROWSER_CLIENT_ID,
    code_verifier: record.verifier,
  });
  if (!tokens.refresh) {
    throw new SignInError('exchange', 'The issuer returned no refresh token — the session could not outlive its first access token');
  }
  return { pending: record, tokens: { access: tokens.access, refresh: tokens.refresh } };
}

function parsePending(raw: string): PendingAuthorization | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { state, verifier, redirectUri, target, issuer, kbId, expectedDid, expectedName } = value;
  if (!isString(state) || !isString(verifier) || !isString(redirectUri)) return null;
  if (
    !isObject(target) || target['kind'] !== 'http' || !isString(target['host'])
    || typeof target['port'] !== 'number' || (target['protocol'] !== 'http' && target['protocol'] !== 'https')
  ) {
    return null;
  }
  if (!isObject(issuer) || !isString(issuer['issuer']) || !isString(issuer['authorization']) || !isString(issuer['token'])) {
    return null;
  }
  return {
    state,
    verifier,
    redirectUri,
    target: { kind: 'http', host: target['host'], port: target['port'], protocol: target['protocol'] },
    issuer: {
      issuer: issuer['issuer'],
      authorization: issuer['authorization'],
      token: issuer['token'],
      ...(isString(issuer['device']) ? { device: issuer['device'] } : {}),
      ...(isString(issuer['revocation']) ? { revocation: issuer['revocation'] } : {}),
    },
    ...(isString(kbId) ? { kbId } : {}),
    ...(isString(expectedDid) ? { expectedDid } : {}),
    ...(isString(expectedName) ? { expectedName } : {}),
  };
}

// ---------- Token endpoint ----------

async function postForm(
  endpoint: string,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body: isObject(body) ? body : null };
}

function oauthError(body: Record<string, unknown> | null): string | undefined {
  return body && isString(body['error']) ? body['error'] : undefined;
}

function refusal(status: number, body: Record<string, unknown> | null): string {
  const code = oauthError(body);
  if (!code) return `HTTP ${status}`;
  return body && isString(body['error_description']) ? `${code}: ${body['error_description']}` : code;
}

async function tokenGrant(endpoint: string, form: Record<string, string>): Promise<{ access: string; refresh?: string }> {
  const { status, body } = await postForm(endpoint, form);
  if (status !== 200 || !body || !isString(body['access_token'])) {
    throw new SignInError('exchange', `The issuer refused the token request (${refusal(status, body)})`, status);
  }
  return { access: body['access_token'], ...(isString(body['refresh_token']) ? { refresh: body['refresh_token'] } : {}) };
}

/** The refresh grant. An issuer that does not rotate refresh tokens returns none; the one held stays current. */
export async function refreshAtIssuer(tokenEndpoint: string, clientId: string, refreshToken: string): Promise<IssuedTokens> {
  const tokens = await tokenGrant(tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  return { access: tokens.access, refresh: tokens.refresh ?? refreshToken };
}

/**
 * How hard to try before a renewal is declared unrenewable
 * (REFRESH-FAILURE-TRANSIENT-VS-TERMINAL P0.2). Four attempts with ceilings of
 * 0.5 s, 1 s, 2 s — long enough to ride out a gateway restart or a rolling
 * deploy, short enough that a user with no connectivity waits seconds rather
 * than a minute before being told. Not `STARTUP_FETCH_RETRY`: that one is sized
 * for a cold stack, and a refresh rides an already-running one.
 */
const REFRESH_RETRY: RetryPolicy = { attempts: 4, initialDelayMs: 500, maxDelayMs: 4_000 };

/**
 * Renew a stored session at its issuer and persist the rotation.
 *
 * **Null means only that nothing is stored** — an absence, not a failure. A
 * renewal that FAILS throws, carrying the issuer's own words and, when the
 * retry budget ran out, how many attempts it took to give up.
 *
 * That is a deliberate narrowing of what `null` meant (it used to mean every
 * failure too), and it costs the caller nothing: SSE-AUTH-RESILIENCE P0 made a
 * throw and a null identical at the session — `tryRefresh` converts one to the
 * other — and it did so specifically to keep the cause, which a bare `null`
 * cannot carry. An operator reading `Token refresh failed: HTTP 503` still
 * cannot tell whether that was tried once or four times, and the difference
 * decides whether they look at the network or at the issuer.
 *
 * **A refusal and an outage are no longer the same event.** They used to be: a
 * bare `catch { return null }` meant one lost packet ended a session exactly
 * like a revocation. `RETRY_RULES.refresh` draws the line — the issuer's answer
 * is the verdict, its absence never is — and the retry lives here rather than
 * in the session because SSE-AUTH-RESILIENCE P0 settled that a session
 * terminates on `null` and said where retry belongs instead: "in the callback,
 * which owns the HTTP call."
 *
 * The budget is bounded and exhaustion is still terminal, which is the answer
 * to that plan's objection — an invisible zombie session would be worse than a
 * visible re-login, so this only ever delays the re-login, never replaces it.
 */
export async function refreshStoredSession(storage: SessionStorage, kbId: string): Promise<string | null> {
  const stored = getStoredSession(storage, kbId);
  if (!stored) return null;

  let attempts = 0;
  try {
    const { access, refresh } = await retryWithBackoff(
      () => {
        attempts += 1;
        return refreshAtIssuer(stored.tokenEndpoint, stored.clientId, stored.refresh);
      },
      // `status` absent means `fetch` threw before a response existed, which
      // the rule reads as transient — the one place absence means "try again".
      (error) => RETRY_RULES.refresh.retryable(
        error instanceof SignInError && error.status !== undefined ? { status: error.status } : {},
      ),
      REFRESH_RETRY,
    );
    setStoredSession(storage, kbId, { ...stored, access, refresh });
    return access;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    // One attempt means the issuer answered and the answer was final; more
    // means the budget ran out. Saying which is the whole point of counting.
    if (attempts <= 1) throw error;
    throw new SignInError(
      'exchange',
      `The session could not be renewed after ${attempts} attempts: ${cause}`,
    );
  }
}

/** RFC 7009. The issuer answers 200 for a token it already forgot, so this is idempotent. */
export async function revokeAtIssuer(revocationEndpoint: string, clientId: string, refreshToken: string): Promise<void> {
  const { status } = await postForm(revocationEndpoint, {
    token: refreshToken,
    token_type_hint: 'refresh_token',
    client_id: clientId,
  });
  if (status !== 200) throw new SignInError('exchange', `The issuer refused the revocation (HTTP ${status})`);
}

// ---------- Device authorization grant (a script) ----------

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}

export interface DeviceGrantOptions {
  target: HttpEndpoint;
  /** Where to send the person, once the issuer has minted a code. */
  onCode: (code: DeviceCode) => void;
  signal?: AbortSignal;
}

/**
 * Sign in as a person from a process with no browser: the issuer mints a
 * code, the person approves it wherever they have one, and this polls the
 * token endpoint at the issuer's interval until the tokens arrive.
 */
export async function signInWithDeviceGrant(opts: DeviceGrantOptions): Promise<{ issuer: IssuerEndpoints; tokens: IssuedTokens }> {
  const issuer = await discoverIssuer(opts.target);
  if (!issuer.device) {
    throw new SignInError('discovery', `Issuer ${issuer.issuer} offers no device authorization endpoint — the device grant needs one enabled for client ${SCRIPT_CLIENT_ID}`);
  }
  const { status, body } = await postForm(issuer.device, { client_id: SCRIPT_CLIENT_ID, scope: SCOPE });
  if (
    status !== 200 || !body
    || !isString(body['device_code']) || !isString(body['user_code']) || !isString(body['verification_uri'])
  ) {
    throw new SignInError('exchange', `The issuer refused the device authorization request (${refusal(status, body)})`);
  }
  const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : 600;
  opts.onCode({
    userCode: body['user_code'],
    verificationUri: body['verification_uri'],
    ...(isString(body['verification_uri_complete']) ? { verificationUriComplete: body['verification_uri_complete'] } : {}),
    expiresIn,
  });

  let interval = Math.max(typeof body['interval'] === 'number' ? body['interval'] : 5, 1) * 1000;
  const deadline = Date.now() + expiresIn * 1000;
  for (;;) {
    await sleep(interval, opts.signal);
    if (Date.now() > deadline) throw new SignInError('expired', 'The code expired before it was approved');
    const poll = await postForm(issuer.token, {
      grant_type: DEVICE_GRANT,
      device_code: body['device_code'],
      client_id: SCRIPT_CLIENT_ID,
    });
    if (poll.status === 200 && poll.body && isString(poll.body['access_token'])) {
      const refresh = poll.body['refresh_token'];
      if (!isString(refresh)) {
        throw new SignInError('exchange', 'The issuer returned no refresh token — the session could not outlive its first access token');
      }
      return { issuer, tokens: { access: poll.body['access_token'], refresh } };
    }
    switch (oauthError(poll.body)) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += 5000;
        break;
      case 'access_denied':
        throw new SignInError('denied', 'The sign-in was denied at the issuer');
      case 'expired_token':
        throw new SignInError('expired', 'The code expired before it was approved');
      default:
        throw new SignInError('exchange', `The issuer refused the token request (${refusal(poll.status, poll.body)})`);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SignInError('aborted', 'The sign-in was abandoned'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SignInError('aborted', 'The sign-in was abandoned'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
