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
