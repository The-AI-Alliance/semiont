/**
 * Pure-data tests for the projection reducers.
 *
 * These pin the projection-update semantics without filesystem I/O.
 * The materializer's I/O shell is tested separately in
 * `view-materializer.test.ts` (it just confirms read→reduce→write
 * still works); this file owns the conditions on the reducer itself.
 */

import { describe, it, expect } from 'vitest';
import type { TagSchema } from '@semiont/core';
import {
  applyEntityTypeAdded,
  applyTagSchemaAdded,
} from '../../views/projection-reducers';

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
