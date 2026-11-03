// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpKb } from '@semiont/sdk';
import type { AuthBridge, Resumed } from './auth-bridge';
import { connect } from './session';

const KB = httpKb({ id: 'kb.example.org:4000', label: 'Example', host: 'kb.example.org', port: 4000, protocol: 'http' });
const SIGN_IN_REACHED = 'the person was sent to sign in';

/** A desktop shell whose stored session resumes as `resumed`, and whose sign-in stops the
 *  connection where it would open a browser: these tests are about which way `connect`
 *  goes, not about the session it builds after. */
function shellResuming(resumed: Resumed): AuthBridge {
  return {
    resume: vi.fn(async () => resumed),
    signIn: vi.fn(async () => {
      throw new Error(SIGN_IN_REACHED);
    }),
    refresh: vi.fn(async () => null),
    signOut: vi.fn(async () => {}),
  };
}

afterEach(() => {
  delete window.authBridge;
});

describe('connect — what it does with the stored session it finds', () => {
  it('a launch with nothing stored connects nothing and opens nothing', async () => {
    window.authBridge = shellResuming({ kind: 'none' });
    expect(await connect(KB, { interactive: false, onEnded: () => {} })).toBeNull();
    expect(window.authBridge.signIn).not.toHaveBeenCalled();
  });

  it('a launch whose stored session the issuer refused says so, and opens nothing', async () => {
    window.authBridge = shellResuming({ kind: 'refused', reason: 'invalid_grant: Invalid refresh token' });
    await expect(connect(KB, { interactive: false, onEnded: () => {} })).rejects.toThrow(
      /refused to renew the stored session \(invalid_grant: Invalid refresh token\)/,
    );
    expect(window.authBridge.signIn).not.toHaveBeenCalled();
  });

  it('Connect with a refused or no stored session sends the person to sign in', async () => {
    for (const resumed of [{ kind: 'refused', reason: 'expired' }, { kind: 'none' }] as const) {
      window.authBridge = shellResuming(resumed);
      await expect(connect(KB, { interactive: true, onEnded: () => {} })).rejects.toThrow(SIGN_IN_REACHED);
    }
  });

  it('a session that cannot be renewed for an outage is an error either way: signing in would not fix it', async () => {
    const outage = new Error('The session could not be renewed after 4 attempts: fetch failed');
    for (const interactive of [false, true]) {
      window.authBridge = { ...shellResuming({ kind: 'none' }), resume: vi.fn(async () => Promise.reject(outage)) };
      await expect(connect(KB, { interactive, onEnded: () => {} })).rejects.toThrow(outage.message);
      expect(window.authBridge.signIn).not.toHaveBeenCalled();
    }
  });
});
