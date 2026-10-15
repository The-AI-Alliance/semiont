/**
 * SessionSignals — the notification state a UI host shows as modals.
 *
 * Each signal is ONE subject of one value: null while nothing is raised, the
 * notice while something is. Two subjects, a payload and a timestamp, could
 * be read consistently only by an accident of write order.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
import { createSessionSignals, type SessionSignals } from '../session-signals';

let signals: SessionSignals;

beforeEach(() => {
  signals = createSessionSignals();
});

/** Every value `subject` emits from here on, the current one included. */
function collect<T>(subject: { subscribe(next: (value: T) => void): unknown }): T[] {
  const seen: T[] = [];
  subject.subscribe((value) => seen.push(value));
  return seen;
}

describe('SessionSignals — session ended', () => {
  it('raising it is one emission that carries the reason, not a sentence', () => {
    const seen = collect(signals.sessionEnded$);
    signals.notifySessionEnded('refused');
    expect(seen).toEqual([null, { reason: 'refused' }]);
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

describe('SessionSignals — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms, and hands out no notice that a reader could write', () => {
    assertStateUnitAxioms<SessionSignals>({
      setup: () => createSessionSignals(),
      surfaces: (u) => [u.sessionEnded$, u.permissionDenied$, u.kbIdentityConflict$],
      invocations: (u) => [
        () => u.notifySessionEnded('expired'),
        () => u.notifyPermissionDenied(null),
        () => u.notifyKbIdentityConflict({ expectedDid: 'did:web:kb.example.org', observedDid: 'did:web:other.example.org' }),
        () => u.acknowledgeSessionEnded(),
        () => u.acknowledgePermissionDenied(),
        () => u.acknowledgeKbIdentityConflict(),
      ],
    });
    expect('next' in signals.sessionEnded$).toBe(false);
  });
});
