import { describe, it, expect } from 'vitest';
import { BehaviorSubject, ReplaySubject, Subject } from 'rxjs';
import { map, shareReplay } from 'rxjs/operators';
import { assertStateUnitAxioms, disposeProbe } from '../state-unit-axioms';
import type { StateUnit } from '../state-unit';

/**
 * The harness is enforcement infrastructure: a bug in it makes every axiom block
 * across the monorepo lie. So it is tested directly here — every axiom's PASS path
 * (a fully-compliant fixture exercising all accessors) and every axiom's FAIL path
 * (a fixture that violates exactly that axiom while satisfying the ones before it).
 */
describe('assertStateUnitAxioms — the harness has teeth', () => {
  it('passes a fully-compliant unit exercising every accessor (does not cry wolf)', () => {
    // setup returns the { unit, passedIn, teardown } form and provides surfaces,
    // invocations (sync + async → swallowAsync), and ownedChildSurfaces — so this
    // single case drives every axiom's happy path.
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const a$ = new BehaviorSubject<number>(0);
          const b$ = new BehaviorSubject<string>('');
          const child$ = new BehaviorSubject<boolean>(false);
          const probe = disposeProbe();
          const unit = {
            a$: a$.asObservable(),
            b$: b$.asObservable(),
            child: { state$: child$.asObservable() },
            browse: probe, // injected dependency, re-exposed but NOT disposed
            set(v: number) { a$.next(v); },
            async ping(): Promise<void> { /* async → exercises swallowAsync */ },
            dispose() { a$.complete(); b$.complete(); child$.complete(); },
          };
          return { unit, passedIn: [probe], teardown: () => { /* noop */ } };
        },
        surfaces: (u) => [u.a$, u.b$],
        invocations: (u) => [() => u.set(1), () => u.ping()],
        ownedChildSurfaces: (u) => [u.child.state$],
      }),
    ).not.toThrow();
  });

  it('accepts the bare-unit setup form (no passedIn/teardown wrapper)', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const s = new BehaviorSubject<number>(0);
          return { s$: s.asObservable(), dispose: () => s.complete() }; // bare unit
        },
        surfaces: (u) => [u.s$],
      }),
    ).not.toThrow();
  });

  it('A1: rejects a class instance (not a plain object)', () => {
    class NotPlain implements StateUnit {
      dispose(): void { /* noop */ }
    }
    expect(() => assertStateUnitAxioms({ setup: () => new NotPlain() })).toThrow(/A1/);
  });

  it('X1: rejects a raw origin Subject on the public surface', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const s = new Subject<number>();
          return { unit: { leaked: s, dispose: () => s.complete() } }; // ❌ raw Subject exposed
        },
      }),
    ).toThrow(/X1/);
  });

  it('X1: does NOT flag a derived AnonymousSubject (shareReplay().pipe(...))', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const src = new BehaviorSubject<number>(0);
          // shareReplay + pipe yields an AnonymousSubject (instanceof Subject, but
          // carries a `.source` and is an inert sink) — must be excluded by X1.
          const derived$ = src.pipe(shareReplay({ bufferSize: 1, refCount: true }), map((x) => x));
          return { unit: { derived$, dispose: () => src.complete() } };
        },
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

  it('A5: rejects a dispose() that is not idempotent (throws on a repeat call)', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          let n = 0;
          const s = new BehaviorSubject<number>(0);
          return {
            s$: s.asObservable(),
            dispose() { n += 1; if (n > 1) throw new Error('not idempotent'); s.complete(); },
          };
        },
        surfaces: (u) => [u.s$],
      }),
    ).toThrow(/A5/);
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

  it('A5b: rejects a public method that throws after dispose', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const s = new BehaviorSubject<number>(0);
          return {
            s$: s.asObservable(),
            boom() { throw new Error('not inert after dispose'); }, // ❌ throws post-dispose
            dispose: () => s.complete(),
          };
        },
        surfaces: (u) => [u.s$],
        invocations: (u) => [() => u.boom()],
      }),
    ).toThrow(/A5b/);
  });

  it('A7-owned: rejects when an owned child surface does not complete on dispose', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const own = new BehaviorSubject<number>(0);
          const child = new BehaviorSubject<boolean>(false);
          return {
            own$: own.asObservable(),
            child$: child.asObservable(),
            dispose() { own.complete(); /* ❌ forgets the child */ },
          };
        },
        surfaces: (u) => [u.own$],
        ownedChildSurfaces: (u) => [u.child$],
      }),
    ).toThrow(/A7-owned/);
  });

  it('inert: rejects a surface that replays a value to a post-dispose subscriber', () => {
    expect(() =>
      assertStateUnitAxioms({
        setup: () => {
          const r = new ReplaySubject<number>(1);
          r.next(42); // completed-then-subscribed still replays 42 → not inert
          return { unit: { r$: r.asObservable(), dispose: () => r.complete() } };
        },
        surfaces: (u) => [u.r$],
      }),
    ).toThrow(/inert/);
  });
});
