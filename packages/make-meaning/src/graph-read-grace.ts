/**
 * Single-resource read-after-write grace for graph consumers
 * (bugs/graph-read-after-write-coverage.md).
 *
 * Graph-first, VIEW-fallback: when an id-keyed `kb.graph.getResource` read
 * misses (or the store hiccups) but the resource exists in the view, the
 * caller is racing the Weaver's apply — and the view is the FRESHER
 * projection, already holding the full `ResourceDescriptor` these call
 * sites need. No waiting and no retry loops: a bounded backoff inside a
 * candidate loop would multiply into seconds, while the fallback is one
 * read of a projection that is already correct.
 *
 * This is the "third instance" shared helper GRAPH-PROJECTION-SYNC
 * anticipated. It deliberately does NOT replace `buildKnowledgeGraph`'s
 * barrier + bounded retry: traversal needs the node IN the graph — a
 * fallback descriptor cannot serve edges.
 *
 * `laggedBehindView` is the L4 breadcrumb hook — callers log it, so
 * degradation is observable, never silent.
 */

import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base.js';

export interface GracedResource {
  resource: ResourceDescriptor | null;
  laggedBehindView: boolean;
}

export async function resourceWithViewGrace(
  kb: KnowledgeBase,
  rid: ResourceId,
): Promise<GracedResource> {
  const fromGraph = await kb.graph.getResource(rid).catch(() => null);
  if (fromGraph) return { resource: fromGraph, laggedBehindView: false };

  const view = await kb.views.get(rid);
  if (view) return { resource: view.resource, laggedBehindView: true };

  return { resource: null, laggedBehindView: false };
}
