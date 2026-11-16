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
 * The dispatcher's I/O shell — the part that actually reads the
 * projection and reacts to the validator's result — is tested
 * separately in `handlers/job-commands.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { TagSchema } from '@semiont/core';
import {
  resolveTagSchema,
  validateEntityTypes,
  entityTypesNotRegisteredMessage,
} from '../../views/projection-validators';

// Arbitraries. Same shape as in projection-reducers.test.ts — kept
// narrow so counterexamples shrink to readable values.
const tagNameArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);
const schemaIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);

const tagSchemaArb = fc.record({
  id: schemaIdArb,
  name: fc.string({ minLength: 1, maxLength: 30 }),
  description: fc.string({ minLength: 0, maxLength: 50 }),
  domain: fc.constantFrom('legal', 'scientific', 'general', 'test'),
  tags: fc.array(
    fc.record({
      name: tagNameArb,
      description: fc.string({ minLength: 0, maxLength: 30 }),
      examples: fc.array(fc.string({ minLength: 0, maxLength: 20 }), { maxLength: 3 }),
    }),
    { maxLength: 5 },
  ),
});

const SCHEMA_A: TagSchema = {
  id: 'schema-a',
  name: 'Schema A',
  description: 'A test schema',
  domain: 'test',
  tags: [{ name: 'X', description: 'cat X', examples: [] }],
};

const SCHEMA_B: TagSchema = {
  id: 'schema-b',
  name: 'Schema B',
  description: 'Another test schema',
  domain: 'test',
  tags: [{ name: 'Y', description: 'cat Y', examples: [] }],
};

describe('resolveTagSchema', () => {
  it('returns the schema when the id is registered', () => {
    const result = resolveTagSchema([SCHEMA_A, SCHEMA_B], 'schema-a');
    expect(result.error).toBeUndefined();
    expect(result.schema).toBe(SCHEMA_A);
  });

  it('returns "Tag schema not registered" when the id is unknown', () => {
    const result = resolveTagSchema([SCHEMA_A], 'schema-missing');
    expect(result.schema).toBeUndefined();
    expect(result.error).toBe('Tag schema not registered: schema-missing');
  });

  it('returns "Tag schema not registered" against an empty registry', () => {
    const result = resolveTagSchema([], 'schema-a');
    expect(result.error).toBe('Tag schema not registered: schema-a');
  });

  it('returns "tag-annotation requires schemaId" for an empty string', () => {
    const result = resolveTagSchema([SCHEMA_A], '');
    expect(result.error).toBe('tag-annotation requires schemaId');
  });

  it('returns "tag-annotation requires schemaId" for a non-string', () => {
    expect(resolveTagSchema([SCHEMA_A], undefined).error).toBe('tag-annotation requires schemaId');
    expect(resolveTagSchema([SCHEMA_A], null).error).toBe('tag-annotation requires schemaId');
    expect(resolveTagSchema([SCHEMA_A], 42).error).toBe('tag-annotation requires schemaId');
  });

  it('does not partial-match — schemaId is exact-match by id', () => {
    const result = resolveTagSchema([SCHEMA_A], 'schema');
    expect(result.error).toBe('Tag schema not registered: schema');
  });
});

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

describe('axioms — resolveTagSchema', () => {
  it('round-trip: every registered schema is resolvable by its id', () => {
    fc.assert(
      fc.property(
        fc.array(tagSchemaArb, { minLength: 1, maxLength: 10 }),
        (schemas) => {
          // Dedup by id since the registry is a set-on-id (mirrors
          // what applyTagSchemaAdded produces). Pick any registered
          // schema and confirm we can look it up.
          const byId = new Map<string, TagSchema>();
          for (const s of schemas) byId.set(s.id, s);
          for (const [, schema] of byId) {
            const result = resolveTagSchema(Array.from(byId.values()), schema.id);
            expect(result.error).toBeUndefined();
            expect(result.schema).toBe(schema);
          }
        },
      ),
    );
  });

  it('mutual exclusion: result has either schema or error, never both, never neither', () => {
    fc.assert(
      fc.property(
        fc.array(tagSchemaArb, { maxLength: 8 }),
        fc.oneof(
          schemaIdArb,
          fc.constant(''),
          fc.integer() as fc.Arbitrary<unknown>,
          fc.constant(undefined),
          fc.constant(null),
        ),
        (schemas, schemaId) => {
          const result = resolveTagSchema(schemas, schemaId);
          const hasSchema = result.schema !== undefined;
          const hasError = result.error !== undefined;
          expect(hasSchema !== hasError).toBe(true); // XOR
        },
      ),
    );
  });

  it('non-string or empty schemaId always produces "tag-annotation requires schemaId"', () => {
    fc.assert(
      fc.property(
        fc.array(tagSchemaArb, { maxLength: 8 }),
        fc.oneof(
          fc.constant(''),
          fc.constant(undefined),
          fc.constant(null),
          fc.integer(),
          fc.boolean(),
          fc.array(fc.string()),
          fc.object(),
        ) as fc.Arbitrary<unknown>,
        (schemas, schemaId) => {
          const result = resolveTagSchema(schemas, schemaId);
          expect(result.error).toBe('tag-annotation requires schemaId');
        },
      ),
    );
  });

  it('unknown non-empty schemaId always produces "Tag schema not registered: <id>"', () => {
    fc.assert(
      fc.property(
        fc.array(tagSchemaArb, { maxLength: 8 }),
        schemaIdArb,
        (schemas, candidateId) => {
          // Force the candidate to be unknown by filtering it out.
          const filtered = schemas.filter((s) => s.id !== candidateId);
          const result = resolveTagSchema(filtered, candidateId);
          expect(result.error).toBe(`Tag schema not registered: ${candidateId}`);
        },
      ),
    );
  });

  it('does not mutate the input list', () => {
    fc.assert(
      fc.property(fc.array(tagSchemaArb, { maxLength: 10 }), schemaIdArb, (schemas, id) => {
        const before = JSON.stringify(schemas);
        resolveTagSchema(schemas, id);
        expect(JSON.stringify(schemas)).toBe(before);
      }),
    );
  });
});

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
