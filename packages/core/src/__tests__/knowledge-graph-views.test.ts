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
      edges: [{ source: 'res-main', target: 'res-peer', type: 'cites', bidirectional: true }],
    };

    const views = deriveViews(graph, 'res-main');

    expect(views.connections).toEqual([
      { resourceId: 'res-peer', resourceName: 'Peer', entityTypes: ['Author'], bidirectional: true },
    ]);
  });

  it('derives citedBy + citedByCount from citation edges, KEEPING missing-view citers (Option A)', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'res-main', type: 'resource', label: 'Main', entityTypes: [] },
        { id: 'res-citing', type: 'resource', label: 'Citing Paper', entityTypes: [] },
        // a citer whose view was missing at build time → labeled by its raw id
        { id: 'res-noview', type: 'resource', label: 'res-noview', entityTypes: [] },
      ],
      edges: [
        { source: 'res-citing', target: 'res-main', type: 'citation' },
        { source: 'res-noview', target: 'res-main', type: 'citation' },
      ],
    };

    const views = deriveViews(graph, 'res-main');

    expect(views.citedByCount).toBe(2);
    expect(views.citedBy).toEqual([
      { resourceId: 'res-citing', resourceName: 'Citing Paper' },
      { resourceId: 'res-noview', resourceName: 'res-noview' },
    ]);
  });

  it('derives siblingEntityTypes as the union of annotation-node types, EXCLUDING the focal annotation', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'res-main', type: 'resource', label: 'Main', entityTypes: [] },
        { id: 'ann-focal', type: 'annotation', label: 'commenting', entityTypes: ['Focal'] },
        { id: 'ann-sib-1', type: 'annotation', label: 'linking', entityTypes: ['Author', 'Org'] },
        { id: 'ann-sib-2', type: 'annotation', label: 'commenting', entityTypes: ['Org'] },
      ],
      edges: [],
    };

    const views = deriveViews(graph, 'res-main', 'ann-focal');

    expect([...views.siblingEntityTypes].sort()).toEqual(['Author', 'Org']);
    expect(views.siblingEntityTypes).not.toContain('Focal');
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
