/**
 * Pure-data tests for the projection validators.
 *
 * These pin the dispatcher's read-validate-or-resolve semantics
 * without filesystem I/O, EventBus wiring, or Stower setup. The
 * dispatcher's I/O shell — the part that actually reads the
 * projection and reacts to the validator's result — is tested
 * separately in `handlers/job-commands.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { TagSchema } from '@semiont/core';
import {
  resolveTagSchema,
  validateEntityTypes,
  entityTypesNotRegisteredMessage,
} from '../../views/projection-validators';

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
