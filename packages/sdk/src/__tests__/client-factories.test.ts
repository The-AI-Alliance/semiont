/**
 * Tests for `SemiontClient.fromHttp(...)` and `SemiontClient.signIn(...)`.
 *
 * `fromHttp` is purely structural: it constructs `HttpTransport` +
 * `HttpContentTransport`, threads a fresh `BehaviorSubject<AccessToken>`
 * through, brands string inputs, and returns a wired client. We assert
 * on the wiring it can hand back without going to the wire.
 *
 * `signIn` adds an auth round-trip on top. We spy on
 * `HttpTransport.prototype.authenticatePassword` to keep the test
 * off-network and exercise:
 *   - success: token populated, client returned
 *   - failure: client disposed before re-throw (no leaked HTTP transport)
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  accessToken as makeAccessToken,
  baseUrl as makeBaseUrl,
} from '@semiont/core';
import { HttpTransport, HttpContentTransport } from '@semiont/api-client';

import { SemiontClient } from '../client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SemiontClient.fromHttp', () => {
  test('accepts string baseUrl and brands it; returns a SemiontClient', () => {
    const client = SemiontClient.fromHttp({ baseUrl: 'http://test.local' });
    try {
      expect(client).toBeInstanceOf(SemiontClient);
      expect(client.baseUrl).toBe('http://test.local');
      expect(client.transport).toBeInstanceOf(HttpTransport);
    } finally {
      client.dispose();
    }
  });

  test('accepts already-branded BaseUrl', () => {
    const url = makeBaseUrl('http://branded.local');
    const client = SemiontClient.fromHttp({ baseUrl: url });
    try {
      expect(client.baseUrl).toBe('http://branded.local');
    } finally {
      client.dispose();
    }
  });

  test('accepts string token and brands it', () => {
    const client = SemiontClient.fromHttp({
      baseUrl: 'http://test.local',
      token: 'header.payload.sig',
    });
    try {
      // The token flows into the transport's internal token$, which the
      // transport reads from when assembling Authorization. We can't read
      // it back without going through HTTP, but we can assert construction
      // succeeded and the client is usable.
      expect(client).toBeInstanceOf(SemiontClient);
    } finally {
      client.dispose();
    }
  });

  test('accepts already-branded AccessToken', () => {
    const tok = makeAccessToken('header.payload.sig');
    const client = SemiontClient.fromHttp({
      baseUrl: 'http://test.local',
      token: tok,
    });
    try {
      expect(client).toBeInstanceOf(SemiontClient);
    } finally {
      client.dispose();
    }
  });

  test('omitting token constructs an unauthenticated client', () => {
    const client = SemiontClient.fromHttp({ baseUrl: 'http://test.local' });
    try {
      expect(client).toBeInstanceOf(SemiontClient);
    } finally {
      client.dispose();
    }
  });

  test('null token is treated as no token', () => {
    const client = SemiontClient.fromHttp({
      baseUrl: 'http://test.local',
      token: null,
    });
    try {
      expect(client).toBeInstanceOf(SemiontClient);
    } finally {
      client.dispose();
    }
  });

  test('dispose() shuts down the underlying transport+content cleanly', () => {
    const client = SemiontClient.fromHttp({ baseUrl: 'http://test.local' });
    // dispose() should not throw and should be idempotent enough that the
    // test runner cleanup succeeds.
    expect(() => client.dispose()).not.toThrow();
  });
});

describe('SemiontClient.signIn', () => {
  test('calls auth.password against the constructed transport and returns a wired client', async () => {
    // Spy on the transport prototype so the real HTTP layer is never invoked.
    const passwordSpy = vi
      .spyOn(HttpTransport.prototype, 'authenticatePassword')
      .mockResolvedValue({ token: 'jwt-from-server', user: { did: 'did:test:u' } } as never);

    const client = await SemiontClient.signIn({
      baseUrl: 'http://test.local',
      email: 'me@example.com',
      password: 'pwd',
    });

    try {
      expect(client).toBeInstanceOf(SemiontClient);
      expect(passwordSpy).toHaveBeenCalledTimes(1);
      const [emailArg, passwordArg] = passwordSpy.mock.calls[0]!;
      expect(emailArg).toBe('me@example.com');
      expect(passwordArg).toBe('pwd');
    } finally {
      client.dispose();
    }
  });

  test('accepts an already-branded BaseUrl', async () => {
    vi.spyOn(HttpTransport.prototype, 'authenticatePassword').mockResolvedValue({
      token: 't',
      user: { did: 'did:test:u' },
    } as never);

    const client = await SemiontClient.signIn({
      baseUrl: makeBaseUrl('http://branded.local'),
      email: 'a@b.com',
      password: 'p',
    });
    try {
      expect(client.baseUrl).toBe('http://branded.local');
    } finally {
      client.dispose();
    }
  });

  test('disposes the transient client and rethrows when auth fails', async () => {
    // Spy on dispose at the construction site by capturing it on prototype
    // — every SemiontClient instance shares the dispose method. Easier:
    // capture the HttpTransport.prototype.dispose call count before/after.
    const disposeSpy = vi.spyOn(HttpTransport.prototype, 'dispose');
    const failure = new Error('invalid credentials');
    vi.spyOn(HttpTransport.prototype, 'authenticatePassword').mockRejectedValue(failure);

    const before = disposeSpy.mock.calls.length;

    await expect(
      SemiontClient.signIn({
        baseUrl: 'http://test.local',
        email: 'me@example.com',
        password: 'wrong',
      }),
    ).rejects.toBe(failure);

    expect(disposeSpy.mock.calls.length).toBeGreaterThan(before);
  });
});
