/**
 * resourceWithViewGrace Tests (bugs/graph-read-after-write-coverage.md, P1/P2)
 *
 * The shared single-resource read-after-write grace for graph consumers:
 * graph-first, VIEW-fallback. When an id-keyed descriptor read misses the
 * graph but the resource exists in the view, the caller is racing the
 * Weaver's apply — and the view is the FRESHER projection, already holding
 * the full descriptor these call sites need. No waiting, no retry loops.
 * This is the "third instance" shared helper GRAPH-PROJECTION-SYNC
 * anticipated (its P1 retry stays exclusive to buildKnowledgeGraph, which
 * needs the node IN the graph for traversal).
 */

import { describe, it, expect, vi } from 'vitest';
import { resourceId } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';
import { resourceWithViewGrace } from '../graph-read-grace';

const DOC = { '@id': 'res-1', name: 'From Graph', representations: [], archived: false, entityTypes: [] };
const VIEW_DOC = { '@id': 'res-1', name: 'From View', representations: [], archived: false, entityTypes: [] };

function kbWith(graphDoc: unknown, viewDoc: unknown): KnowledgeBase {
  return {
    graph: { getResource: vi.fn().mockResolvedValue(graphDoc) } as any,
    views: { get: vi.fn().mockResolvedValue(viewDoc ? { resource: viewDoc, annotations: {} } : null) } as any,
  } as unknown as KnowledgeBase;
}

describe('resourceWithViewGrace', () => {
  it('returns the graph descriptor when the graph has it — no view read, no lag flag', async () => {
    const kb = kbWith(DOC, VIEW_DOC);
    const result = await resourceWithViewGrace(kb, resourceId('res-1'));

    expect(result.resource?.name).toBe('From Graph');
    expect(result.laggedBehindView).toBe(false);
    expect((kb.views.get as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('falls back to the view descriptor when the graph lags — flagged for the breadcrumb', async () => {
    const kb = kbWith(null, VIEW_DOC);
    const result = await resourceWithViewGrace(kb, resourceId('res-1'));

    expect(result.resource?.name).toBe('From View');
    expect(result.laggedBehindView).toBe(true);
  });

  it('returns null for a resource neither projection knows — a true unknown, unflagged', async () => {
    const kb = kbWith(null, null);
    const result = await resourceWithViewGrace(kb, resourceId('res-ghost'));

    expect(result.resource).toBeNull();
    expect(result.laggedBehindView).toBe(false);
  });

  it('a throwing graph read degrades to the view, not to a rejection', async () => {
    const kb = {
      graph: { getResource: vi.fn().mockRejectedValue(new Error('neo4j hiccup')) } as any,
      views: { get: vi.fn().mockResolvedValue({ resource: VIEW_DOC, annotations: {} }) } as any,
    } as unknown as KnowledgeBase;

    const result = await resourceWithViewGrace(kb, resourceId('res-1'));
    expect(result.resource?.name).toBe('From View');
    expect(result.laggedBehindView).toBe(true);
  });
});
