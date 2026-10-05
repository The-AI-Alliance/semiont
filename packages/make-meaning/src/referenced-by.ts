/**
 * What refers to a resource: the annotations elsewhere whose body cites it,
 * each with the name of the resource it sits in.
 *
 * An inbound-edge query, so it reads the graph: retrieval, which the
 * Librarian answers (`gather:referenced-by-requested`).
 */

import { getExactText, getTargetSelector, getTargetSource } from '@semiont/core';
import type { Logger, ResourceId, components } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import type { ViewStorage } from '@semiont/event-sourcing';
import { resourceWithViewGrace } from './graph-read-grace';

export interface ReferencedByReads {
  graph: Pick<GraphDatabase, 'getResourceReferencedBy' | 'getResource'>;
  views: Pick<ViewStorage, 'get'>;
}

export async function findReferencedBy(
  kb: ReferencedByReads,
  resourceId: ResourceId,
  motivation: string | undefined,
  logger: Logger,
): Promise<components['schemas']['GetReferencedByResponse']['referencedBy']> {
  // The inbound edge query is eventually consistent BY DESIGN: the
  // racing write lives in the CITING resource's stream, so no
  // per-resource wait key exists here — and every consumer sits behind
  // the SDK's referencedBy cache, whose staleness window dwarfs the
  // Weaver's ~tens-of-ms apply lag. A just-woven edge appears on the
  // next read.
  const references = await kb.graph.getResourceReferencedBy(resourceId, motivation);

  const sourceIds = [...new Set(references.map(ref => getTargetSource(ref.target)))];
  // Citer hydration IS id-keyed: graph-first with view fallback — a
  // woven edge whose endpoint isn't woven yet must not render
  // "Untitled Resource"; the view holds the fresher descriptor.
  const resolved = await Promise.all(
    sourceIds.map(id => resourceWithViewGrace(kb, id)),
  );

  const docMap = new Map(
    resolved.filter(r => r.resource !== null).map(r => [r.resource!['@id'], r.resource!]),
  );
  for (let i = 0; i < sourceIds.length; i++) {
    if (resolved[i].laggedBehindView) {
      logger.info('[graph lag] citer hydrated from view', { resourceId: sourceIds[i] });
    } else if (resolved[i].resource === null) {
      logger.warn('Referenced resource not found in graph or view', { resourceId: sourceIds[i] });
    }
  }

  return references.map(ref => {
    const targetSource = getTargetSource(ref.target);
    const targetSelector = getTargetSelector(ref.target);
    const doc = targetSource ? docMap.get(targetSource) : undefined;
    return {
      id: ref.id,
      resourceName: doc?.name || 'Untitled Resource',
      target: {
        source: targetSource,
        selector: {
          exact: targetSelector ? getExactText(targetSelector) : '',
        },
      },
    };
  });
}
