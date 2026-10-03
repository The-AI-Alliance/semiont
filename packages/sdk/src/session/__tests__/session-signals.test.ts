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
    expect(signals.sessionEnded$.getValue()).toBeNull();
    expect(signals.permissionDenied$.getValue()).toBeNull();
    expect(signals.kbIdentityConflict$.getValue()).toBeNull();
  });
});

describe('SessionSignals — session ended', () => {
  it('raising it is one emission that carries the reason, not a sentence', () => {
    const seen = collect(signals.sessionEnded$);
    signals.notifySessionEnded('refused');
    expect(seen).toEqual([null, { reason: 'refused' }]);
  });

  it('carries each reason as given: the host writes what a person reads', () => {
    signals.notifySessionEnded('expired');
    expect(signals.sessionEnded$.getValue()).toEqual({ reason: 'expired' });
  });

  it('acknowledging it is one emission back to null', () => {
    signals.notifySessionEnded('expired');
    const seen = collect(signals.sessionEnded$);
    signals.acknowledgeSessionEnded();
    expect(seen).toEqual([{ reason: 'expired' }, null]);
  });

  it('a second occurrence reaches an observer, the same reason included', () => {
    const seen = collect(signals.sessionEnded$);
    signals.notifySessionEnded('expired');
    signals.notifySessionEnded('expired');
    expect(seen).toHaveLength(3);
  });
});

describe('SessionSignals — permission denied', () => {
  it("raising it is one emission that carries the gateway's own words as the detail", () => {
    const seen = collect(signals.permissionDenied$);
    signals.notifyPermissionDenied('Archiving needs the curator role.');
    expect(seen).toEqual([null, { detail: 'Archiving needs the curator role.' }]);
  });

  it('a gateway that said nothing is a null detail, never a sentence made up for it', () => {
    signals.notifyPermissionDenied(null);
    expect(signals.permissionDenied$.getValue()).toEqual({ detail: null });
  });

  it('acknowledging it is one emission back to null', () => {
    signals.notifyPermissionDenied('nope');
    const seen = collect(signals.permissionDenied$);
    signals.acknowledgePermissionDenied();
    expect(seen).toEqual([{ detail: 'nope' }, null]);
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
    signals.sessionEnded$.subscribe({ complete: () => completed.push('sessionEnded') });
    signals.permissionDenied$.subscribe({ complete: () => completed.push('permissionDenied') });
    signals.kbIdentityConflict$.subscribe({ complete: () => completed.push('kbIdentityConflict') });

    signals.dispose();

    expect(completed).toEqual(['sessionEnded', 'permissionDenied', 'kbIdentityConflict']);
  });
});
