/**
 * Pure-data tests for the projection validators.
 *
 * Two layers:
 *  1. **Example-based tests** pin specific scenarios — empty registry,
 *     unknown id, exact-match-not-prefix, etc.
 *  2. **Axioms** (the `describe('axioms — ...')` blocks below) use
 *     fast-check to assert invariants over arbitrary inputs:
 *     soundness, completeness, mutual exclusion, no mutation.
 *
 * The Stower's I/O shell — the part that actually reads the projection
 * and reacts to the validator's result — is tested in
 * `stower-entity-types.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateEntityTypes,
  entityTypesNotRegisteredMessage,
} from '../../views/projection-validators';

// Arbitraries. Same shape as in projection-reducers.test.ts — kept
// narrow so counterexamples shrink to readable values.
const tagNameArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);
describe('validateEntityTypes', () => {
  it('passes when all requested tags are registered', () => {
    const result = validateEntityTypes(['Person', 'Organization', 'Location'], ['Person', 'Location']);
    expect(result).toEqual({ ok: true });
  });

  it('rejects with the unknown tags listed', () => {
    const result = validateEntityTypes(['Person'], ['Person', 'NotRegistered', 'AlsoMissing']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknown).toEqual(['NotRegistered', 'AlsoMissing']);
    }
  });

  it('preserves caller-supplied order in the unknown list', () => {
    const result = validateEntityTypes(['Person'], ['Z', 'A', 'M']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknown).toEqual(['Z', 'A', 'M']);
    }
  });

  it('passes when requested is undefined (no validation needed)', () => {
    expect(validateEntityTypes(['Person'], undefined)).toEqual({ ok: true });
  });

  it('passes when requested is the empty array (no validation needed)', () => {
    expect(validateEntityTypes(['Person'], [])).toEqual({ ok: true });
  });

  it('rejects against an empty registry when any tag is requested', () => {
    const result = validateEntityTypes([], ['Person']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unknown).toEqual(['Person']);
  });

  it('passes against an empty registry when no tags are requested', () => {
    expect(validateEntityTypes([], undefined)).toEqual({ ok: true });
    expect(validateEntityTypes([], [])).toEqual({ ok: true });
  });

  it('does not mutate either input', () => {
    const registered = ['Person'];
    const requested = ['Person', 'Missing'];
    validateEntityTypes(registered, requested);
    expect(registered).toEqual(['Person']);
    expect(requested).toEqual(['Person', 'Missing']);
  });
});

describe('entityTypesNotRegisteredMessage', () => {
  it('formats a single unknown tag', () => {
    expect(entityTypesNotRegisteredMessage(['Foo'])).toBe('Entity type not registered: Foo');
  });

  it('comma-joins multiple unknown tags', () => {
    expect(entityTypesNotRegisteredMessage(['Foo', 'Bar', 'Baz']))
      .toBe('Entity type not registered: Foo, Bar, Baz');
  });
});

// ── Axioms ─────────────────────────────────────────────────────────────
//
// Properties that hold for ANY input. The example-based tests above
// pin specific scenarios; these pin the *shape* of the result regardless
// of inputs.

describe('axioms — validateEntityTypes', () => {
  it('soundness: every reported unknown is actually missing from registered', () => {
    fc.assert(
      fc.property(
        fc.array(tagNameArb, { maxLength: 20 }),
        fc.array(tagNameArb, { maxLength: 20 }),
        (registered, requested) => {
          const result = validateEntityTypes(registered, requested);
          if (!result.ok) {
            const set = new Set(registered);
            for (const u of result.unknown) expect(set.has(u)).toBe(false);
          }
        },
      ),
    );
  });

  it('completeness: every actually-missing requested tag is reported as unknown', () => {
    fc.assert(
      fc.property(
        fc.array(tagNameArb, { maxLength: 20 }),
        fc.array(tagNameArb, { maxLength: 20 }),
        (registered, requested) => {
          const result = validateEntityTypes(registered, requested);
          const set = new Set(registered);
          const expectedUnknown = requested.filter((t) => !set.has(t));
          if (expectedUnknown.length === 0) {
            expect(result).toEqual({ ok: true });
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(new Set(result.unknown)).toEqual(new Set(expectedUnknown));
            }
          }
        },
      ),
    );
  });

  it('order preservation: unknown[] reflects the order of `requested`', () => {
    fc.assert(
      fc.property(
        fc.array(tagNameArb, { maxLength: 10 }),
        fc.array(tagNameArb, { minLength: 1, maxLength: 15 }),
        (registered, requested) => {
          const result = validateEntityTypes(registered, requested);
          if (!result.ok) {
            // Walk `requested` and confirm result.unknown is the
            // subsequence consisting of items not in registered.
            const set = new Set(registered);
            const expected: string[] = [];
            for (const t of requested) if (!set.has(t)) expected.push(t);
            expect(result.unknown).toEqual(expected);
          }
        },
      ),
    );
  });

  it('reflexivity: validating registered against itself always passes', () => {
    fc.assert(
      fc.property(fc.array(tagNameArb, { maxLength: 20 }), (registered) => {
        const result = validateEntityTypes(registered, registered);
        expect(result).toEqual({ ok: true });
      }),
    );
  });

  it('empty/undefined requested always passes (no validation triggered)', () => {
    fc.assert(
      fc.property(
        fc.array(tagNameArb, { maxLength: 20 }),
        fc.constantFrom([], undefined),
        (registered, requested) => {
          expect(validateEntityTypes(registered, requested as readonly string[] | undefined)).toEqual({ ok: true });
        },
      ),
    );
  });

  it('does not mutate either input', () => {
    fc.assert(
      fc.property(
        fc.array(tagNameArb, { maxLength: 10 }),
        fc.array(tagNameArb, { maxLength: 10 }),
        (registered, requested) => {
          const before = [JSON.stringify(registered), JSON.stringify(requested)];
          validateEntityTypes(registered, requested);
          expect(JSON.stringify(registered)).toBe(before[0]);
          expect(JSON.stringify(requested)).toBe(before[1]);
        },
      ),
    );
  });
});
