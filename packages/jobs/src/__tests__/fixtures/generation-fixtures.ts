import type { GatheredContext, GenerationJobParams } from '@semiont/core';

/**
 * Minimal HONEST fixtures for the generation params contract (YIELD-FROM-
 * CONTEXT P1): every field satisfies the generated types with no casts, so
 * these break loudly if the schema's required sets move.
 *
 * `GEN_REQUIRED` is the wire's required trio; spread it FIRST and override:
 * `{ ...GEN_REQUIRED, title: 'T' }`.
 */
export function minimalContext(kind: 'resource' | 'annotation' = 'resource'): GatheredContext {
  const sourceResource = {
    '@context': 'https://semiont.dev/context/v1',
    '@id': 'res-1',
    name: 'Source',
    representations: [],
  };
  return {
    focus:
      kind === 'resource'
        ? { kind, resource: sourceResource }
        : {
            kind,
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld',
              type: 'Annotation',
              id: 'ann-1',
              motivation: 'linking',
              target: { source: 'res-1' },
            },
            sourceResource,
          },
    graph: { nodes: [], edges: [] },
    metadata: {},
  };
}

export const GEN_REQUIRED: Pick<GenerationJobParams, 'title' | 'storageUri' | 'context'> = {
  title: 'Generated',
  storageUri: 'file://generated/out.md',
  context: minimalContext(),
};
