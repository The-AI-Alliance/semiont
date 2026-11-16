/**
 * deriveViews — flattened neighborhood views from a KnowledgeGraph (CONTEXT-UNIFICATION P3, Q1=A).
 * Moved here from make-meaning so jobs can share it (the function is pure over the core type).
 */
import { describe, it, expect } from 'vitest';
import { deriveViews } from '../knowledge-graph-views';
import type { components } from '../types';

type KnowledgeGraph = components['schemas']['KnowledgeGraph'];

describe('deriveViews', () => {
  it('derives connections from main→peer edges (name, entityTypes, bidirectional)', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'res-main', type: 'resource', label: 'Main', entityTypes: ['Paper'] },
        { id: 'res-peer', type: 'resource', label: 'Peer', entityTypes: ['Author'] },
      ],
      // relationshipType is a free string a stored connection can name anything —
      // even 'cites'. Derivation is structural (endpoints), so this stays a
      // connection and never leaks into citedBy (D12).
      edges: [{ source: 'res-main', target: 'res-peer', type: 'cites', bidirectional: true }],
    };

    const views = deriveViews(graph, 'res-main');

    expect(views.connections).toEqual([
      { resourceId: 'res-peer', resourceName: 'Peer', entityTypes: ['Author'], bidirectional: true },
    ]);
  });

  it('derives citedBy from citing linking annotations (cites + annotation-of), deduped per citing resource, KEEPING missing-view citers (D12, Option A)', () => {
    const ann = (id: string, source: string) => ({
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id,
      motivation: 'linking' as const,
      target: { source },
    });
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'res-main', type: 'resource', label: 'Main', entityTypes: [] },
        { id: 'res-citing', type: 'resource', label: 'Citing Paper', entityTypes: [] },
        // two citations from the SAME resource: two annotation nodes, ONE citedBy row
        { id: 'ann-cite-1', type: 'annotation', label: 'linking', annotation: ann('ann-cite-1', 'res-citing') },
        { id: 'ann-cite-2', type: 'annotation', label: 'linking', annotation: ann('ann-cite-2', 'res-citing') },
        // a citer whose view was missing at build time: no resource node → raw-id label
        { id: 'ann-noview', type: 'annotation', label: 'linking', annotation: ann('ann-noview', 'res-noview') },
      ],
      edges: [
        { source: 'ann-cite-1', target: 'res-citing', type: 'annotation-of' },
        { source: 'ann-cite-1', target: 'res-main', type: 'cites' },
        { source: 'ann-cite-2', target: 'res-citing', type: 'annotation-of' },
        { source: 'ann-cite-2', target: 'res-main', type: 'cites' },
        { source: 'ann-noview', target: 'res-noview', type: 'annotation-of' },
        { source: 'ann-noview', target: 'res-main', type: 'cites' },
      ],
    };

    const views = deriveViews(graph, 'res-main');

    expect(views.citedByCount).toBe(2); // citing RESOURCES, not citing annotations
    expect(views.citedBy).toEqual([
      { resourceId: 'res-citing', resourceName: 'Citing Paper' },
      { resourceId: 'res-noview', resourceName: 'res-noview' },
    ]);
  });

  it('derives siblingEntityTypes from annotations ON the focal resource, excluding the focal annotation AND citing annotations (D12)', () => {
    const ann = (id: string, source: string) => ({
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id,
      motivation: 'linking' as const,
      target: { source },
    });
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'res-main', type: 'resource', label: 'Main', entityTypes: [] },
        { id: 'res-other', type: 'resource', label: 'Other', entityTypes: [] },
        { id: 'ann-focal', type: 'annotation', label: 'commenting', entityTypes: ['Focal'], annotation: ann('ann-focal', 'res-main') },
        { id: 'ann-sib-1', type: 'annotation', label: 'linking', entityTypes: ['Author', 'Org'], annotation: ann('ann-sib-1', 'res-main') },
        { id: 'ann-sib-2', type: 'annotation', label: 'commenting', entityTypes: ['Org'], annotation: ann('ann-sib-2', 'res-main') },
        // a CITING annotation lives on another resource — not a sibling
        { id: 'ann-citing', type: 'annotation', label: 'linking', entityTypes: ['Leaky'], annotation: ann('ann-citing', 'res-other') },
      ],
      edges: [
        { source: 'ann-focal', target: 'res-main', type: 'annotation-of' },
        { source: 'ann-sib-1', target: 'res-main', type: 'annotation-of' },
        { source: 'ann-sib-2', target: 'res-main', type: 'annotation-of' },
        { source: 'ann-citing', target: 'res-other', type: 'annotation-of' },
        { source: 'ann-citing', target: 'res-main', type: 'cites' },
      ],
    };

    const views = deriveViews(graph, 'res-main', 'ann-focal');

    expect([...views.siblingEntityTypes].sort()).toEqual(['Author', 'Org']);
    expect(views.siblingEntityTypes).not.toContain('Focal');
    expect(views.siblingEntityTypes).not.toContain('Leaky');
  });

  it('returns empty views for a graph with only the main node', () => {
    const graph: KnowledgeGraph = {
      nodes: [{ id: 'res-main', type: 'resource', label: 'Main', entityTypes: [] }],
      edges: [],
    };

    expect(deriveViews(graph, 'res-main')).toEqual({
      connections: [],
      citedBy: [],
      citedByCount: 0,
      siblingEntityTypes: [],
    });
  });
});
