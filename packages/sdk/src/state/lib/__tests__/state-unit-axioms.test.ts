import { describe, it, expect } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { assertStateUnitAxioms, disposeProbe } from '../state-unit-axioms';
import type { StateUnit } from '../state-unit';

/**
 * The harness must have teeth: each axiom rejects a deliberately non-compliant
 * fixture. Without these, a green axiom block proves nothing — the helper could
 * be a no-op. The compliant case proves it doesn't cry wolf.
 */
describe('assertStateUnitAxioms — the harness has teeth', () => {
  it('passes a compliant unit (does not cry wolf)', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const s = new BehaviorSubject<number>(0);
          return { unit: { value$: s.asObservable(), dispose: () => s.complete() } };
        },
        surfaces: (u) => [u.value$],
      }),
    ).not.toThrow();
  });

  it('A7-passed: rejects a unit that disposes an injected dependency', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const probe = disposeProbe();
          const unit: StateUnit = { dispose: () => probe.dispose() }; // ❌ disposes what it doesn't own
          return { unit, passedIn: [probe] };
        },
      }),
    ).toThrow(/A7-passed/);
  });

  it('X1: rejects a raw Subject on the public surface', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const s = new Subject<number>();
          return { unit: { leaked: s, dispose: () => s.complete() } }; // ❌ exposes the Subject itself
        },
      }),
    ).toThrow(/X1/);
  });

  it('A6: rejects an owned surface that does not complete on dispose', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const s = new BehaviorSubject<number>(0);
          return { unit: { value$: s.asObservable(), dispose: () => { /* ❌ forgets to complete */ } } };
        },
        surfaces: (u) => [u.value$],
      }),
    ).toThrow(/A6|complete/);
  });
});
