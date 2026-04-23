/**
 * FrontendSessionSignals — unit tests for the modal-state observables
 * previously embedded in SemiontSession. The class has no external
 * dependencies; these tests exercise the state transitions directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FrontendSessionSignals } from '../frontend-session-signals';

let signals: FrontendSessionSignals;

beforeEach(() => {
  signals = new FrontendSessionSignals();
});

describe('FrontendSessionSignals — session expired', () => {
  it('starts with null modal state', () => {
    expect(signals.sessionExpiredAt$.getValue()).toBeNull();
    expect(signals.sessionExpiredMessage$.getValue()).toBeNull();
  });

  it('notifySessionExpired sets at$ to a timestamp and message$ to the given message', () => {
    signals.notifySessionExpired('your session ended');
    expect(signals.sessionExpiredAt$.getValue()).toBeGreaterThan(0);
    expect(signals.sessionExpiredMessage$.getValue()).toBe('your session ended');
  });

  it('notifySessionExpired falls back to a default message when null is passed', () => {
    signals.notifySessionExpired(null);
    expect(signals.sessionExpiredMessage$.getValue()).toMatch(/session has expired/i);
  });

  it('acknowledgeSessionExpired clears both fields', () => {
    signals.notifySessionExpired('expired');
    signals.acknowledgeSessionExpired();
    expect(signals.sessionExpiredAt$.getValue()).toBeNull();
    expect(signals.sessionExpiredMessage$.getValue()).toBeNull();
  });
});

describe('FrontendSessionSignals — permission denied', () => {
  it('starts with null modal state', () => {
    expect(signals.permissionDeniedAt$.getValue()).toBeNull();
    expect(signals.permissionDeniedMessage$.getValue()).toBeNull();
  });

  it('notifyPermissionDenied sets at$ and message$', () => {
    signals.notifyPermissionDenied('not allowed');
    expect(signals.permissionDeniedAt$.getValue()).toBeGreaterThan(0);
    expect(signals.permissionDeniedMessage$.getValue()).toBe('not allowed');
  });

  it('falls back to a default message when null is passed', () => {
    signals.notifyPermissionDenied(null);
    expect(signals.permissionDeniedMessage$.getValue()).toMatch(/do not have permission/i);
  });

  it('acknowledgePermissionDenied clears both fields', () => {
    signals.notifyPermissionDenied('nope');
    signals.acknowledgePermissionDenied();
    expect(signals.permissionDeniedAt$.getValue()).toBeNull();
    expect(signals.permissionDeniedMessage$.getValue()).toBeNull();
  });
});

describe('FrontendSessionSignals — dispose', () => {
  it('completes all four observables', () => {
    const flags = { se: false, sem: false, pd: false, pdm: false };
    signals.sessionExpiredAt$.subscribe({ complete: () => { flags.se = true; } });
    signals.sessionExpiredMessage$.subscribe({ complete: () => { flags.sem = true; } });
    signals.permissionDeniedAt$.subscribe({ complete: () => { flags.pd = true; } });
    signals.permissionDeniedMessage$.subscribe({ complete: () => { flags.pdm = true; } });

    signals.dispose();

    expect(flags).toEqual({ se: true, sem: true, pd: true, pdm: true });
  });
});
