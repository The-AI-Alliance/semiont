/**
 * Tests for `SemiontClient.fromHttp(...)`.
 *
 * `fromHttp` is purely structural: it constructs `HttpTransport` +
 * `HttpContentTransport`, threads a fresh `BehaviorSubject<AccessToken>`
 * through, brands string inputs, and returns a wired client. We assert
 * on the wiring it can hand back without going to the wire.
 *
 * The credentials-first factory that used to live here was DELETED
 * (SSE-AUTH-RESILIENCE P5) — it handed out a token that never refreshed.
 * Its replacement and its coverage are `SemiontSession.signInHttp`, tested in
 * `session/__tests__/semiont-session-factories.test.ts`.
 *
 * `fromHttp` never authenticates, so nothing here goes to the wire.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  accessToken as makeAccessToken,
  baseUrl as makeBaseUrl,
} from '@semiont/core';
import { HttpTransport } from '@semiont/http-transport';

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
