import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setStoredSession } from '@semiont/sdk';
import { FileSessionStorage } from './session-file';

// The handlers `registerAuthHandlers` gives `ipcMain`, called here as the preload would.
const handlers = vi.hoisted(() => new Map<string, (event: null, ...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: null, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  shell: { openExternal: async () => {} },
}));

const { registerAuthHandlers, sessionPath } = await import('./auth');

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler(null, ...args));
}

/** The issuer's token endpoint, as the refresh grant meets it: one path renews (rotating
 *  the refresh token), one refuses the way Keycloak refuses a dead refresh token. */
let issuer: Server;
let issuerUrl = '';

function storeSession(kbId: string, tokenEndpoint: string): void {
  setStoredSession(new FileSessionStorage(sessionPath(kbId)), kbId, {
    access: 'stored-access',
    refresh: 'stored-refresh',
    clientId: 'semiont-browser',
    tokenEndpoint,
  });
}

beforeAll(async () => {
  process.env['XDG_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'chat-auth-'));
  registerAuthHandlers();
  issuer = createServer((request, response) => {
    if (request.url === '/renews') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: 'renewed-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 300 }));
      return;
    }
    response
      .writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid refresh token' }));
  });
  await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', resolve));
  const address = issuer.address();
  if (address === null || typeof address === 'string') throw new Error('the test issuer has no port');
  issuerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => issuer.close(() => resolve()));
});

describe('auth:resume — what a stored session is found to be', () => {
  it('nothing is stored', async () => {
    expect(await invoke('auth:resume', 'none:4000')).toEqual({ value: { kind: 'none' } });
  });

  it('renewed: the new access token, and the rotated refresh token kept', async () => {
    storeSession('renews:4000', `${issuerUrl}/renews`);
    expect(await invoke('auth:resume', 'renews:4000')).toEqual({ value: { kind: 'resumed', access: 'renewed-access' } });
    expect(readFileSync(sessionPath('renews:4000'), 'utf8')).toContain('rotated-refresh');
  });

  it('refused by the issuer: the person signs in again, told the issuer’s own answer', async () => {
    storeSession('refused:4000', `${issuerUrl}/refuses`);
    expect(await invoke('auth:resume', 'refused:4000')).toEqual({
      value: { kind: 'refused', reason: expect.stringMatching(/invalid_grant/) },
    });
  });

  it('an issuer that does not answer is an error with its cause, not "nothing stored"', async () => {
    storeSession('unreachable:4000', 'http://127.0.0.1:1/token');
    expect(await invoke('auth:resume', 'unreachable:4000')).toEqual({
      error: expect.stringMatching(/could not be renewed after \d+ attempts/),
    });
    // The session is not thrown away for an outage.
    expect(existsSync(sessionPath('unreachable:4000'))).toBe(true);
  }, 20_000);

  it('a session file that cannot be read is an error naming the file, and is left for the person to see', async () => {
    const path = sessionPath('unreadable:4000');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json');
    expect(await invoke('auth:resume', 'unreadable:4000')).toEqual({
      error: expect.stringContaining(`${path} is not a session file`),
    });
    expect(existsSync(path)).toBe(true);
  });
});

describe('auth:sign-out', () => {
  it('forgets a session it cannot read, as asked', async () => {
    const path = sessionPath('unreadable-out:4000');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json');
    await invoke('auth:sign-out', 'unreadable-out:4000');
    expect(existsSync(path)).toBe(false);
  });
});
