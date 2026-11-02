import { ipcMain, shell } from 'electron';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { RETRY_RULES, isNumber, isObject, isString } from '@semiont/core';
import {
  BROWSER_CLIENT_ID,
  InMemorySessionStorage,
  SignInError,
  beginAuthorization,
  completeAuthorization,
  parseJwtExpiry,
  refreshStoredSession,
  revokeAtIssuer,
  setStoredSession,
  type HttpEndpoint,
  type StoredSession,
} from '@semiont/sdk';
import type { Resumed } from '../src/lib/auth-bridge';
import { openLoopbackRedirect } from './loopback';
import { appendLog, configDir } from './paths';
import { FileSessionStorage } from './session-file';

// Everything chat says to a knowledge base's issuer is said from here (the renderer reaches
// it through `window.authBridge`, src/lib/auth-bridge.ts). An issuer answers the origins its
// client registration lists and refuses every other; this process sends no `Origin`, so it
// is answered. The tokens are kept here too, a file per knowledge base, and the renderer is
// handed access tokens only.
//
// The sign-in is the authorization code grant with PKCE at a loopback redirect (RFC 8252),
// as the client an application a person uses signs in as.

/** How long a person has to finish signing in at the issuer. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** A held access token this close to its expiry is renewed before it is handed out. */
const RENEW_WITHIN_MS = 60_000;

const storages = new Map<string, FileSessionStorage>();
/** The access token last issued for a knowledge base, this run. */
const held = new Map<string, string>();
const renewals = new Map<string, Promise<string | null>>();
const signIns = new Map<string, Promise<string>>();

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where a knowledge base's session is kept. */
export function sessionPath(kbId: string): string {
  return join(configDir(), 'sessions', `${encodeURIComponent(kbId)}.json`);
}

/** A knowledge base's session store, opened once a run. A file that cannot be read throws,
 *  naming it. */
function storageFor(kbId: string): FileSessionStorage {
  const open = storages.get(kbId);
  if (open !== undefined) return open;
  const storage = new FileSessionStorage(sessionPath(kbId));
  storages.set(kbId, storage);
  return storage;
}

/** Whether a failed renewal is the issuer's verdict on the session (it answered, and the
 *  SDK's refresh rule says another try cannot change the answer), as opposed to the issuer
 *  not answering. `refreshStoredSession` throws a verdict as the issuer's own answer, on
 *  the first attempt; an issuer that never answered is retried and then reported as such. */
function refusedByIssuer(err: unknown): err is SignInError {
  return (
    err instanceof SignInError && err.status !== undefined && !RETRY_RULES.refresh.retryable({ status: err.status })
  );
}

/** One renewal at a time per knowledge base: an issuer that rotates refresh tokens refuses
 *  the second of two that present the same one. */
function renew(kbId: string): Promise<string | null> {
  const underway = renewals.get(kbId);
  if (underway !== undefined) return underway;
  const renewal = refreshStoredSession(storageFor(kbId), kbId)
    .then((access) => {
      if (access === null) held.delete(kbId);
      else held.set(kbId, access);
      return access;
    })
    .finally(() => renewals.delete(kbId));
  renewals.set(kbId, renewal);
  return renewal;
}

async function resume(kbId: string): Promise<Resumed> {
  const access = held.get(kbId);
  const expiry = access === undefined ? null : parseJwtExpiry(access);
  if (access !== undefined && expiry !== null && expiry.getTime() - Date.now() > RENEW_WITHIN_MS) {
    return { kind: 'resumed', access };
  }
  try {
    const renewed = await renew(kbId);
    return renewed === null ? { kind: 'none' } : { kind: 'resumed', access: renewed };
  } catch (err) {
    if (refusedByIssuer(err)) return { kind: 'refused', reason: describe(err) };
    throw err;
  }
}

async function authorize(kbId: string, target: HttpEndpoint): Promise<string> {
  const loopback = await openLoopbackRedirect(SIGN_IN_TIMEOUT_MS);
  try {
    const pending = new InMemorySessionStorage();
    const issuerUrl = await beginAuthorization({ target, redirectUri: loopback.redirectUri }, pending);
    await shell.openExternal(issuerUrl);
    const { pending: authorization, tokens } = await completeAuthorization(await loopback.callbackUrl, pending);
    const session: StoredSession = {
      access: tokens.access,
      refresh: tokens.refresh,
      clientId: BROWSER_CLIENT_ID,
      tokenEndpoint: authorization.issuer.token,
      ...(authorization.issuer.revocation !== undefined ? { revocationEndpoint: authorization.issuer.revocation } : {}),
    };
    setStoredSession(storageFor(kbId), kbId, session);
    held.set(kbId, tokens.access);
    return tokens.access;
  } finally {
    loopback.close();
  }
}

/** One sign-in at a time per knowledge base: a second Connect joins the browser tab
 *  already open rather than opening another. */
function signIn(kbId: string, target: HttpEndpoint): Promise<string> {
  const underway = signIns.get(kbId);
  if (underway !== undefined) return underway;
  const attempt = authorize(kbId, target).finally(() => signIns.delete(kbId));
  signIns.set(kbId, attempt);
  return attempt;
}

/** What a sign-out needs of a stored session, read back out of the file. The SDK writes a
 *  `StoredSession` as JSON and exports no reader for one. */
function revocable(value: string): Pick<StoredSession, 'refresh' | 'clientId' | 'revocationEndpoint'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isString(parsed.refresh) || !isString(parsed.clientId)) return null;
  if (!isString(parsed.revocationEndpoint)) return null;
  return { refresh: parsed.refresh, clientId: parsed.clientId, revocationEndpoint: parsed.revocationEndpoint };
}

async function signOut(kbId: string): Promise<void> {
  held.delete(kbId);
  let storage: FileSessionStorage;
  try {
    storage = storageFor(kbId);
  } catch (err) {
    // Signing out is forgetting the session. One that cannot be read cannot be revoked
    // either: its file is removed as asked, and the log says the issuer still holds it.
    appendLog(`${new Date().toISOString()} [auth] the session for ${kbId} was not revoked: ${describe(err)}`);
    rmSync(sessionPath(kbId), { force: true });
    return;
  }
  for (const value of storage.values()) {
    const session = revocable(value);
    if (session?.revocationEndpoint === undefined) continue;
    try {
      await revokeAtIssuer(session.revocationEndpoint, session.clientId, session.refresh);
    } catch (err) {
      // The session is forgotten here either way; the issuer keeps it until it expires.
      appendLog(`${new Date().toISOString()} [auth] the session for ${kbId} was not revoked: ${describe(err)}`);
    }
  }
  storage.remove();
  storages.delete(kbId);
}

function kbIdOf(value: unknown): string {
  if (!isString(value) || value === '') throw new Error('auth: a knowledge base id is a non-empty string');
  return value;
}

function endpointOf(value: unknown): HttpEndpoint {
  if (
    !isObject(value) ||
    !isString(value.host) ||
    !isNumber(value.port) ||
    (value.protocol !== 'http' && value.protocol !== 'https')
  ) {
    throw new Error('auth: a knowledge base address is { host, port, protocol }');
  }
  return { kind: 'http', host: value.host, port: value.port, protocol: value.protocol };
}

/** What a person may read crosses the bridge as its own sentence: a rejected handler
 *  arrives in the renderer wrapped in Electron's. The preload throws `error` again. */
async function answered<T>(what: string, work: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await work() };
  } catch (err) {
    appendLog(`${new Date().toISOString()} [auth] ${what} failed: ${describe(err)}`);
    return { error: describe(err) };
  }
}

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:resume', (_event, kbId: unknown) => answered('resume', () => resume(kbIdOf(kbId))));
  ipcMain.handle('auth:sign-in', (_event, kbId: unknown, address: unknown) =>
    answered('sign-in', () => signIn(kbIdOf(kbId), endpointOf(address))),
  );
  ipcMain.handle('auth:refresh', (_event, kbId: unknown) => renew(kbIdOf(kbId)));
  ipcMain.handle('auth:sign-out', (_event, kbId: unknown) => signOut(kbIdOf(kbId)));
}
