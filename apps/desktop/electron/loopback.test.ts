import { describe, expect, it } from 'vitest';
import { openLoopbackRedirect } from './loopback';

describe('openLoopbackRedirect', () => {
  it('listens on the loopback interface, at a port of its own', async () => {
    const first = await openLoopbackRedirect(5_000);
    const second = await openLoopbackRedirect(5_000);
    try {
      expect(first.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(second.redirectUri).not.toBe(first.redirectUri);
    } finally {
      first.close();
      second.close();
    }
  });

  it('gives the whole address the issuer sent the person back to, and tells them they are signed in', async () => {
    const loopback = await openLoopbackRedirect(5_000);
    try {
      const sentBackTo = `${loopback.redirectUri}?state=abc&code=xyz`;
      const response = await fetch(sentBackTo);
      expect(response.status).toBe(200);
      expect(await response.text()).toMatch(/Signed in/);
      expect(await loopback.callbackUrl).toBe(sentBackTo);
    } finally {
      loopback.close();
    }
  });

  it('does not tell a person they are signed in when the issuer sent an error back', async () => {
    const loopback = await openLoopbackRedirect(5_000);
    try {
      const sentBackTo = `${loopback.redirectUri}?error=access_denied&state=abc`;
      const page = await (await fetch(sentBackTo)).text();
      expect(page).toMatch(/did not complete/);
      expect(page).not.toMatch(/Signed in/);
      // The address is still given: finishing the grant is what reports the refusal.
      expect(await loopback.callbackUrl).toBe(sentBackTo);
    } finally {
      loopback.close();
    }
  });

  it('answers 404 anywhere but the callback, and keeps waiting', async () => {
    const loopback = await openLoopbackRedirect(5_000);
    try {
      const elsewhere = new URL('/favicon.ico', loopback.redirectUri);
      expect((await fetch(elsewhere)).status).toBe(404);
      const still = await Promise.race([
        loopback.callbackUrl.then(() => 'arrived'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 30)),
      ]);
      expect(still).toBe('waiting');
    } finally {
      loopback.close();
    }
  });

  it('gives up when nobody arrives in time', async () => {
    const loopback = await openLoopbackRedirect(20);
    try {
      await expect(loopback.callbackUrl).rejects.toThrow(/Nobody finished signing in/);
    } finally {
      loopback.close();
    }
  });

  it('stops listening when closed, and may be closed twice', async () => {
    const loopback = await openLoopbackRedirect(5_000);
    loopback.close();
    loopback.close();
    await expect(loopback.callbackUrl).rejects.toThrow(/closed before it finished/);
    await expect(fetch(loopback.redirectUri)).rejects.toThrow();
  });
});
