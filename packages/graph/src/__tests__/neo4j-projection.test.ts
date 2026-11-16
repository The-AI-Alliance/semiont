/**
 * The neo4j → wire annotation projection, tested at the module seam.
 *
 * The writes store temporals natively (`created: datetime($created)`), so the
 * driver hands the projection a neo4j DateTime OBJECT — and `node` is `any`
 * here, so only a test can see one leak into `Annotation.created: string`.
 * That leak shipped: every D11-embedded graph annotation violated the schema,
 * and the first validated round-trip (`match:search-requested`) 400'd — see
 * .plans/bugs/match-search-hangs-on-neo4j-datetime-annotations.md.
 */
import { describe, it, expect } from 'vitest';
import { parseAnnotationNode } from '../implementations/neo4j';

/** The driver temporal's contract: a rich object whose toString() is ISO 8601. */
const driverDateTime = (iso: string) => ({
  year: { low: 2026, high: 0 },
  month: { low: 8, high: 0 },
  toString: () => iso,
});

const node = (created: unknown, modified?: unknown) => ({
  properties: {
    id: 'ann-1',
    resourceId: 'res-1',
    type: 'Annotation',
    motivation: 'linking',
    selector: JSON.stringify({ type: 'TextQuoteSelector', exact: 'Black Hawk' }),
    creator: JSON.stringify({ '@type': 'Person', id: 'did:semiont:user:u1', name: 'A' }),
    created,
    ...(modified !== undefined ? { modified } : {}),
  },
});

describe('parseAnnotationNode — temporals leave as ISO strings, never driver objects', () => {
  it('serializes a native DateTime `created` to its ISO string', () => {
    const ann = parseAnnotationNode(node(driverDateTime('2026-08-19T01:02:03.000000000Z')));
    expect(ann.created).toBe('2026-08-19T01:02:03.000000000Z');
    expect(typeof ann.created).toBe('string');
  });

  it('passes an already-string `created` through unchanged', () => {
    const ann = parseAnnotationNode(node('2026-01-01T00:00:00Z'));
    expect(ann.created).toBe('2026-01-01T00:00:00Z');
  });

  it('serializes `modified` the same way (the pattern `created` failed to follow)', () => {
    const ann = parseAnnotationNode(node('2026-01-01T00:00:00Z', driverDateTime('2026-08-19T04:05:06Z')));
    expect(ann.modified).toBe('2026-08-19T04:05:06Z');
  });
});

describe('parseAnnotationNode — the rest of the projection contract', () => {
  // `type` and `selector` are deliberately absent from this list: the stored
  // `type` never reaches the wire annotation, and a source-only target has no
  // selector at all. Requiring either one is what made the store manufacture
  // a `'{}'` to satisfy itself. See .plans/GRAPH-ANNOTATION-CODEC.md.
  it.each([
    ['id', 'Annotation missing required field: id'],
    ['resourceId', 'missing required field: resourceId'],
    ['creator', 'missing required field: creator'],
    ['motivation', 'missing required field: motivation'],
    ['created', 'missing required field: created'],
  ])('refuses a node missing %s, naming the field', (field, message) => {
    const n = node('2026-01-01T00:00:00Z');
    delete (n.properties as Record<string, unknown>)[field];
    expect(() => parseAnnotationNode(n)).toThrow(message);
  });

  it('reconstructs entity tags as tagging bodies, filtering empty values', () => {
    const ann = parseAnnotationNode(node('2026-01-01T00:00:00Z'), ['Person', '', 'Org']);
    expect(ann.body).toEqual([
      { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
      { type: 'TextualBody', value: 'Org', purpose: 'tagging' },
    ]);
  });

  it('adds the linking body when the annotation is resolved', () => {
    const n = node('2026-01-01T00:00:00Z');
    (n.properties as Record<string, unknown>).source = 'res-target';
    const ann = parseAnnotationNode(n);
    expect(ann.body).toContainEqual({ type: 'SpecificResource', source: 'res-target', purpose: 'linking' });
  });

  it('parses a stored generator, and ignores an unparseable one rather than failing the read', () => {
    const good = node('2026-01-01T00:00:00Z');
    (good.properties as Record<string, unknown>).generator = JSON.stringify({ '@type': 'Software', name: 'semiont' });
    expect(parseAnnotationNode(good).generator).toEqual({ '@type': 'Software', name: 'semiont' });

    const bad = node('2026-01-01T00:00:00Z');
    (bad.properties as Record<string, unknown>).generator = '{ not json';
    const ann = parseAnnotationNode(bad);
    expect(ann.generator).toBeUndefined();
    expect(ann.id).toBe('ann-1'); // the read itself survives
  });
});
