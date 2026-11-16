/**
 * Type-level guard — GATHER-EVIDENCE-PANES P3 (D9 + D11 + D12).
 *
 * The graph node is a discriminated union: a resource node, or an annotation
 * node that IS an annotation's graph presence — so the full W3C annotation is
 * REQUIRED on the annotation member and does not exist on the resource member.
 * No conditionally-present field: "optional but always present on one branch"
 * is the defect shape WIRE-UNION-DISCRIMINANTS spent five phases killing.
 *
 * SemanticMatch names its source (D9, settled required): a card cannot label a
 * passage with a bare resourceId, and corpus matches routinely come from
 * outside the graph neighborhood, so there is no node to borrow a name from.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';

type GraphNode = components['schemas']['KnowledgeGraph']['nodes'][number];
type SemanticMatch = components['schemas']['SemanticMatch'];

const W3C: components['schemas']['Annotation'] = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: 'ann-cite',
  motivation: 'linking',
  target: { source: 'res-citing' },
};

function describeNode(n: GraphNode): string {
  switch (n.type) {
    case 'resource':
      return n.label;
    case 'annotation':
      // Required, not probed for: the node IS the annotation (D11).
      return `${n.annotation.motivation}: ${n.label}`;
    default: {
      const unhandled: never = n;
      return unhandled;
    }
  }
}

describe('KnowledgeGraph node — the union discriminates (D12)', () => {
  it('narrows both members by type, castless', () => {
    expect(describeNode({ id: 'r-1', type: 'resource', label: 'Main' })).toBe('Main');
    expect(describeNode({ id: 'ann-cite', type: 'annotation', label: 'linking', annotation: W3C }))
      .toBe('linking: linking');
  });

  it('an annotation node without its annotation is a skeleton the union forbids', () => {
    // @ts-expect-error — D11: the node is the annotation's graph presence, whole
    const skeleton: GraphNode = { id: 'ann-cite', type: 'annotation', label: 'linking' };
    expect(skeleton).toBeDefined();
  });
});

describe('SemanticMatch — the card can name its source (D9)', () => {
  it('resourceName is required', () => {
    const named: SemanticMatch = { text: 't', resourceId: 'r-1', resourceName: 'The Source', score: 0.91 };
    // @ts-expect-error — a match that cannot name its source no longer typechecks
    const nameless: SemanticMatch = { text: 't', resourceId: 'r-1', score: 0.91 };
    expect({ named, nameless }).toBeDefined();
  });
});
