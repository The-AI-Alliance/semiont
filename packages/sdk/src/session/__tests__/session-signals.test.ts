/**
 * SessionSignals — the notification state a UI host shows as modals.
 *
 * Each signal is ONE subject of one value: null while nothing is raised, the
 * notice while something is. A signal used to be two subjects, a payload and a
 * timestamp, which an observer could only read consistently because the
 * payload happened to be written first.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionSignals } from '../session-signals';

let signals: SessionSignals;

beforeEach(() => {
  signals = new SessionSignals();
});

/** Every value `subject` emits from now on, the current one included. */
function collect<T>(subject: { subscribe(next: (value: T) => void): unknown }): T[] {
  const seen: T[] = [];
  subject.subscribe((value) => seen.push(value));
  return seen;
}

describe('SessionSignals — nothing raised', () => {
  it('every signal starts null', () => {
    expect(signals.sessionExpired$.getValue()).toBeNull();
    expect(signals.permissionDenied$.getValue()).toBeNull();
    expect(signals.kbIdentityConflict$.getValue()).toBeNull();
  });
});

describe('SessionSignals — session expired', () => {
  it('raising it is one emission that carries the message', () => {
    const seen = collect(signals.sessionExpired$);
    signals.notifySessionExpired('your session ended');
    expect(seen).toEqual([null, { message: 'your session ended' }]);
  });

  it('falls back to a default message when null is passed', () => {
    signals.notifySessionExpired(null);
    expect(signals.sessionExpired$.getValue()?.message).toMatch(/session has expired/i);
  });

  it('acknowledging it is one emission back to null', () => {
    signals.notifySessionExpired('expired');
    const seen = collect(signals.sessionExpired$);
    signals.acknowledgeSessionExpired();
    expect(seen).toEqual([{ message: 'expired' }, null]);
  });

  it('a second occurrence reaches an observer, the same message included', () => {
    const seen = collect(signals.sessionExpired$);
    signals.notifySessionExpired('expired');
    signals.notifySessionExpired('expired');
    expect(seen).toHaveLength(3);
  });
});

describe('SessionSignals — permission denied', () => {
  it('raising it is one emission that carries the message', () => {
    const seen = collect(signals.permissionDenied$);
    signals.notifyPermissionDenied('not allowed');
    expect(seen).toEqual([null, { message: 'not allowed' }]);
  });

  it('falls back to a default message when null is passed', () => {
    signals.notifyPermissionDenied(null);
    expect(signals.permissionDenied$.getValue()?.message).toMatch(/do not have permission/i);
  });

  it('acknowledging it is one emission back to null', () => {
    signals.notifyPermissionDenied('nope');
    const seen = collect(signals.permissionDenied$);
    signals.acknowledgePermissionDenied();
    expect(seen).toEqual([{ message: 'nope' }, null]);
  });
});

describe('SessionSignals — KB identity conflict', () => {
  const conflict = { expectedDid: 'did:web:a.example', observedDid: 'did:web:b.example' };

  it('raising it is one emission that carries both dids', () => {
    const seen = collect(signals.kbIdentityConflict$);
    signals.notifyKbIdentityConflict(conflict);
    expect(seen).toEqual([null, conflict]);
  });

  it('acknowledging it is one emission back to null', () => {
    signals.notifyKbIdentityConflict(conflict);
    const seen = collect(signals.kbIdentityConflict$);
    signals.acknowledgeKbIdentityConflict();
    expect(seen).toEqual([conflict, null]);
  });
});

describe('SessionSignals — dispose', () => {
  it('completes every signal', () => {
    const completed: string[] = [];
    signals.sessionExpired$.subscribe({ complete: () => completed.push('sessionExpired') });
    signals.permissionDenied$.subscribe({ complete: () => completed.push('permissionDenied') });
    signals.kbIdentityConflict$.subscribe({ complete: () => completed.push('kbIdentityConflict') });

    signals.dispose();

    expect(completed).toEqual(['sessionExpired', 'permissionDenied', 'kbIdentityConflict']);
  });
});
