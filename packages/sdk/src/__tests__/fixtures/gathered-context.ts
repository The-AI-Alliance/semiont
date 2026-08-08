import type { GatheredContext } from '@semiont/core';

/**
 * Minimal HONEST GatheredContext fixtures (YIELD-FROM-CONTEXT P2): every
 * field satisfies the generated types with no casts, keyed to the caller's
 * ids so derivation pins (`fromContext` extracts resourceId/referenceId from
 * the focus) compare against known values.
 */
export function resourceContextFor(rid: string): GatheredContext {
  return {
    focus: {
      kind: 'resource',
      resource: {
        '@context': 'https://semiont.dev/context/v1',
        '@id': rid,
        name: 'Source',
        representations: [],
      },
    },
    graph: { nodes: [], edges: [] },
    metadata: {},
  };
}

export function annotationContextFor(rid: string, aid: string): GatheredContext {
  return {
    focus: {
      kind: 'annotation',
      annotation: {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: aid,
        motivation: 'linking',
        target: { source: rid },
      },
      sourceResource: {
        '@context': 'https://semiont.dev/context/v1',
        '@id': rid,
        name: 'Source',
        representations: [],
      },
    },
    graph: { nodes: [], edges: [] },
    metadata: {},
  };
}
