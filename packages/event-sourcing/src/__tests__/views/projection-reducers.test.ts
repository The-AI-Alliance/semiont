/**
 * Pure-data tests for the projection reducers.
 *
 * Two layers of coverage live here:
 *
 *  1. **Example-based tests** (the `describe('applyEntityTypeAdded')`
 *     and `describe('applyTagSchemaAdded')` blocks) pin specific
 *     scenarios: empty-list-add, idempotent re-register, replace-with-
 *     warning, etc. Read these to understand the semantics.
 *
 *  2. **Axioms** (the `describe('axioms — ...')` blocks) use fast-check
 *     to assert invariants over arbitrary inputs — sortedness,
 *     uniqueness, idempotence, subset preservation, most-recent-wins.
 *     These catch the weird sequences a hand-rolled test would miss
 *     and would also catch any future change to the reducer that
 *     silently broke a load-bearing property.
 *
 * The materializer's I/O shell is tested separately in
 * `view-materializer.test.ts` — that suite confirms read→reduce→write
 * still works at the file-system layer. This file owns conditions on
 * the reducer logic itself.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { TagSchema } from '@semiont/core';
import {
  applyEntityTypeAdded,
  applyTagSchemaAdded,
} from '../../views/projection-reducers';

// Arbitraries used by the axiom tests. Kept narrow — short
// alphanumeric strings keep counterexamples readable when fast-check
// shrinks a failure.
const tagNameArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);

const tagCategoryArb = fc.record({
  name: tagNameArb,
  description: fc.string({ minLength: 0, maxLength: 30 }),
  examples: fc.array(fc.string({ minLength: 0, maxLength: 20 }), { maxLength: 3 }),
});

const tagSchemaArb = fc.record({
  id: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
  name: fc.string({ minLength: 1, maxLength: 30 }),
  description: fc.string({ minLength: 0, maxLength: 50 }),
  domain: fc.constantFrom('legal', 'scientific', 'general', 'test'),
  tags: fc.array(tagCategoryArb, { minLength: 0, maxLength: 5 }),
});

describe('applyEntityTypeAdded', () => {
  it('adds a tag to an empty list', () => {
    expect(applyEntityTypeAdded([], 'Person')).toEqual(['Person']);
  });

  it('appends a new tag and re-sorts the result', () => {
    expect(applyEntityTypeAdded(['Zebra', 'Apple'], 'Mango')).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('is idempotent — re-adding an existing tag returns an equivalent set', () => {
    const first = applyEntityTypeAdded(['Person'], 'Person');
    const second = applyEntityTypeAdded(first, 'Person');
    expect(first).toEqual(['Person']);
    expect(second).toEqual(['Person']);
  });

  it('does not mutate the input array', () => {
    const input = ['Apple'];
    const out = applyEntityTypeAdded(input, 'Banana');
    expect(input).toEqual(['Apple']);
    expect(out).toEqual(['Apple', 'Banana']);
  });

  it('applying a sequence of adds yields a sorted unique set', () => {
    const result = ['Person', 'Organization', 'Person', 'Location', 'Organization'].reduce(
      (acc, tag) => applyEntityTypeAdded(acc, tag),
      [] as string[],
    );
    expect(result).toEqual(['Location', 'Organization', 'Person']);
  });
});

describe('applyTagSchemaAdded', () => {
  const SCHEMA_A = (override: Partial<TagSchema> = {}): TagSchema => ({
    id: 'schema-a',
    name: 'Schema A',
    description: 'A test schema',
    domain: 'test',
    tags: [
      { name: 'X', description: 'cat X', examples: [] },
      { name: 'Y', description: 'cat Y', examples: [] },
    ],
    ...override,
  });

  const SCHEMA_B = (): TagSchema => ({
    id: 'schema-b',
    name: 'Schema B',
    description: 'Another test schema',
    domain: 'test',
    tags: [{ name: 'Z', description: 'cat Z', examples: [] }],
  });

  it('appends to an empty list', () => {
    const result = applyTagSchemaAdded([], SCHEMA_A());
    expect(result.next).toHaveLength(1);
    expect(result.next[0]?.id).toBe('schema-a');
    expect(result.warning).toBeUndefined();
  });

  it('appends a second schema and sorts the result by id', () => {
    const result = applyTagSchemaAdded([SCHEMA_B()], SCHEMA_A());
    expect(result.next.map((s) => s.id)).toEqual(['schema-a', 'schema-b']);
    expect(result.warning).toBeUndefined();
  });

  it('is silently idempotent on identical re-registration (no warning)', () => {
    const first = applyTagSchemaAdded([], SCHEMA_A());
    const second = applyTagSchemaAdded(first.next, SCHEMA_A());
    expect(second.next).toHaveLength(1);
    expect(second.warning).toBeUndefined();
  });

  it('replaces existing schema and emits a warning when content differs', () => {
    const before = applyTagSchemaAdded([], SCHEMA_A()).next;
    const result = applyTagSchemaAdded(before, SCHEMA_A({ description: 'CHANGED' }));
    expect(result.next).toHaveLength(1);
    expect(result.next[0]?.description).toBe('CHANGED');
    expect(result.warning).toBeDefined();
    expect(result.warning?.schemaId).toBe('schema-a');
    expect(result.warning?.message).toMatch(/overwritten/);
  });

  it('does not mutate the input array', () => {
    const input = [SCHEMA_A()];
    const snapshot = JSON.stringify(input);
    applyTagSchemaAdded(input, SCHEMA_B());
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('handles a sequence of registrations: append, append, idempotent re-register, overwrite', () => {
    const events: Array<TagSchema> = [
      SCHEMA_A(),
      SCHEMA_B(),
      SCHEMA_A(),
      SCHEMA_A({ name: 'New Name For A' }),
    ];

    let view: TagSchema[] = [];
    let warningCount = 0;
    for (const event of events) {
      const result = applyTagSchemaAdded(view, event);
      view = result.next;
      if (result.warning) warningCount++;
    }

    // Final state: two schemas, schema-a has the new name (last write wins)
    expect(view.map((s) => s.id)).toEqual(['schema-a', 'schema-b']);
    expect(view.find((s) => s.id === 'schema-a')?.name).toBe('New Name For A');
    // Warnings: only the final overwrite-with-different-content fires.
    // The 3rd event (re-register identical SCHEMA_A) is silent.
    expect(warningCount).toBe(1);
  });
});

// ── Axioms ─────────────────────────────────────────────────────────────
//
// Properties that must hold for ANY input. fast-check generates random
// inputs (and shrinks counterexamples on failure). These are the
// load-bearing invariants of the projection-update semantics — break
// any one and the projection-on-disk gets corrupt regardless of which
// hand-rolled test you remembered to write.

describe('axioms — applyEntityTypeAdded (entity-type projection)', () => {
  // Folds a sequence of additions starting from the empty list. Many
  // axioms below assert properties of the *resulting* projection
  // independent of insertion order.
  const fold = (tags: readonly string[]): string[] =>
    tags.reduce<string[]>((acc, tag) => applyEntityTypeAdded(acc, tag), []);

  it('output is always sorted', () => {
    fc.assert(
      fc.property(fc.array(tagNameArb, { maxLength: 30 }), (tags) => {
        const out = fold(tags);
        for (let i = 1; i < out.length; i++) {
          expect(out[i - 1]!.localeCompare(out[i]!)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('output has no duplicates', () => {
    fc.assert(
      fc.property(fc.array(tagNameArb, { maxLength: 30 }), (tags) => {
        const out = fold(tags);
        expect(out.length).toBe(new Set(out).size);
      }),
    );
  });

  it('output equals the unique set of inputs (set semantics)', () => {
    fc.assert(
      fc.property(fc.array(tagNameArb, { maxLength: 30 }), (tags) => {
        const out = fold(tags);
        expect(new Set(out)).toEqual(new Set(tags));
      }),
    );
  });

  it('idempotent on individual operations: apply(apply(s, x), x) === apply(s, x)', () => {
    fc.assert(
      fc.property(
        fc.array(tagNameArb, { maxLength: 20 }),
        tagNameArb,
        (initial, x) => {
          const base = fold(initial);
          const once = applyEntityTypeAdded(base, x);
          const twice = applyEntityTypeAdded(once, x);
          expect(twice).toEqual(once);
        },
      ),
    );
  });

  it('order-independent: any permutation of the same input yields the same projection', () => {
    fc.assert(
      fc.property(
        fc.array(tagNameArb, { minLength: 1, maxLength: 12 })
          .chain((tags) => fc.tuple(fc.constant(tags), fc.shuffledSubarray(tags, { minLength: tags.length, maxLength: tags.length }))),
        ([original, shuffled]) => {
          expect(fold(original)).toEqual(fold(shuffled));
        },
      ),
    );
  });

  it('subset-preserving: every tag in the input set is in the output', () => {
    fc.assert(
      fc.property(fc.array(tagNameArb, { maxLength: 30 }), (tags) => {
        const out = new Set(fold(tags));
        for (const t of tags) expect(out.has(t)).toBe(true);
      }),
    );
  });

  it('result.length is bounded by input.length and equal to the unique-input count', () => {
    fc.assert(
      fc.property(fc.array(tagNameArb, { maxLength: 30 }), (tags) => {
        const out = fold(tags);
        expect(out.length).toBe(new Set(tags).size);
        expect(out.length).toBeLessThanOrEqual(tags.length);
      }),
    );
  });
});

describe('axioms — applyTagSchemaAdded (tag-schema projection)', () => {
  // Like the entity-type fold, but tracks whether any warning fired
  // along the way — useful for asserting "warning iff overwrite".
  function fold(events: readonly TagSchema[]): { final: TagSchema[]; warnings: number } {
    let view: TagSchema[] = [];
    let warnings = 0;
    for (const e of events) {
      const r = applyTagSchemaAdded(view, e);
      view = r.next;
      if (r.warning) warnings++;
    }
    return { final: view, warnings };
  }

  it('output is always sorted by id', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { maxLength: 20 }), (schemas) => {
        const { final } = fold(schemas);
        for (let i = 1; i < final.length; i++) {
          expect(final[i - 1]!.id.localeCompare(final[i]!.id)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('output has no duplicate ids', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { maxLength: 20 }), (schemas) => {
        const { final } = fold(schemas);
        const ids = final.map((s) => s.id);
        expect(ids.length).toBe(new Set(ids).size);
      }),
    );
  });

  it('output ids equal the unique set of input ids (set semantics on id)', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { maxLength: 20 }), (schemas) => {
        const { final } = fold(schemas);
        expect(new Set(final.map((s) => s.id))).toEqual(new Set(schemas.map((s) => s.id)));
      }),
    );
  });

  it('most-recent-wins: for every id, the surviving schema is the LAST input with that id', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { minLength: 1, maxLength: 15 }), (schemas) => {
        const { final } = fold(schemas);
        // For every distinct id, look up the last input with that id and
        // confirm it's what survived.
        const lastById = new Map<string, TagSchema>();
        for (const s of schemas) lastById.set(s.id, s);
        for (const survivor of final) {
          expect(survivor).toEqual(lastById.get(survivor.id));
        }
      }),
    );
  });

  it('idempotent on identical re-registration: warning is undefined and the value is unchanged', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { maxLength: 10 }), tagSchemaArb, (initial, x) => {
        const base = fold(initial).final;
        const once = applyTagSchemaAdded(base, x);
        const twice = applyTagSchemaAdded(once.next, x);
        expect(twice.next).toEqual(once.next);
        expect(twice.warning).toBeUndefined();
      }),
    );
  });

  it('warning iff overwrite-with-different-content', () => {
    fc.assert(
      fc.property(
        fc.array(tagSchemaArb, { maxLength: 15 }),
        tagSchemaArb,
        (initial, candidate) => {
          const base = fold(initial).final;
          const r = applyTagSchemaAdded(base, candidate);
          const existing = base.find((s) => s.id === candidate.id);
          const isOverwriteWithDiff =
            existing !== undefined && JSON.stringify(existing) !== JSON.stringify(candidate);
          expect(r.warning !== undefined).toBe(isOverwriteWithDiff);
        },
      ),
    );
  });

  it('subset-preserving on ids: every input id is in the output', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { maxLength: 20 }), (schemas) => {
        const { final } = fold(schemas);
        const outIds = new Set(final.map((s) => s.id));
        for (const s of schemas) expect(outIds.has(s.id)).toBe(true);
      }),
    );
  });

  it('result.next.length is bounded by input.length and equal to the unique-id count', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { maxLength: 20 }), (schemas) => {
        const { final } = fold(schemas);
        expect(final.length).toBe(new Set(schemas.map((s) => s.id)).size);
        expect(final.length).toBeLessThanOrEqual(schemas.length);
      }),
    );
  });

  it('does not mutate the input view (every reduction returns a fresh array)', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { maxLength: 10 }), tagSchemaArb, (initial, candidate) => {
        const base = fold(initial).final;
        const before = JSON.stringify(base);
        applyTagSchemaAdded(base, candidate);
        expect(JSON.stringify(base)).toBe(before);
      }),
    );
  });
});
