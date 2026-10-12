/**
 * The text around a selection, held to specs/src/librarian/window-cases.json:
 * the table every implementation of the Librarian runs, so that a window is
 * cut at the same code points whoever cuts it.
 *
 * The table's `around` cases run `AnnotationContext.extractAnnotationContext`,
 * and `textAround` beside it where the target states a position selector
 * alone. Its `gathered` cases run `AnnotationGather.buildLLMContext` over
 * stores that hold one text resource and the one annotation, and read the
 * selection off the gathered context's focus.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validators, formatErrors } from '@semiont/core/openapi';
import {
  annotationId,
  getTextPositionSelector,
  resourceId,
  type Annotation,
  type ResourceDescriptor,
  type components,
} from '@semiont/core';
import type { ResourceView } from '@semiont/event-sourcing';
import { AnnotationContext, textAround, type AnnotationTextContext } from '../annotation-context';
import { AnnotationGather, type AnnotationGatherReads } from '../annotation-gather';
import { createMockEmbeddingProvider } from './helpers/embedding-provider';

type TargetSelector = components['schemas']['AnnotationTarget']['selector'];

interface AroundCase {
  text: string;
  selector?: TargetSelector;
  window: { before: number; after: number };
  context?: AnnotationTextContext;
  refused?: true;
}

interface GatheredCase {
  text: string;
  selector?: TargetSelector;
  window: number;
  /** `null` when the gathered context states no selection. */
  context?: AnnotationTextContext | null;
  refused?: true;
}

interface Case {
  why: string;
  around?: AroundCase;
  gathered?: GatheredCase;
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/librarian/window-cases.json', import.meta.url), 'utf8'),
);

const part = <K extends 'around' | 'gathered'>(key: K) =>
  table.cases.flatMap((c) => (c[key] ? [{ why: c.why, given: c[key] as NonNullable<Case[K]> }] : []));

/** The generated validators the bus runs: a case states no object the bus could not carry. */
function check(schema: 'Annotation' | 'ResourceView', value: unknown): string | null {
  const validate = validators[schema];
  return validate(value) ? null : formatErrors(validate.errors);
}

const SOURCE = resourceId('res-1');
const ANNOTATION = annotationId('ann-1');

/** The annotation a case is about: one on the text, whose target states the case's selector. */
function annotationOf(selector: TargetSelector): Annotation {
  const annotation: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: ANNOTATION,
    type: 'Annotation',
    motivation: 'highlighting',
    created: '2026-01-01T00:00:00.000Z',
    target: selector === undefined ? { source: SOURCE } : { source: SOURCE, selector },
  };
  expect(check('Annotation', annotation)).toBeNull();
  return annotation;
}

function bytesOf(text: string): ArrayBuffer {
  const buffer = Buffer.from(text, 'utf8');
  const data = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(data).set(buffer);
  return data;
}

/** Stores that hold the one text resource and the one annotation on it, and nothing else. */
function storesOf(text: string, annotation: Annotation): AnnotationGatherReads {
  const resource: ResourceDescriptor = {
    '@context': 'https://schema.org/',
    '@id': SOURCE,
    name: 'A text',
    representations: [{ mediaType: 'text/plain', storageUri: 'file://a-text.txt', checksum: 'sha256:res-1', rel: 'original' }],
  };
  const view: ResourceView = {
    resource,
    annotations: { resourceId: SOURCE, annotations: [annotation], version: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
    lastSequence: 1,
  };
  expect(check('ResourceView', view)).toBeNull();

  return {
    views: { get: async () => view },
    content: { getBinary: async () => ({ data: bytesOf(text), contentType: 'text/plain' }) },
    anchoredText: async () => ({ kind: 'unknown' }),
    graph: {
      getResource: async () => resource,
      getResourceConnections: async () => [],
      getResourceReferencedBy: async () => [],
      getResourceAnnotations: async () => [],
      getEntityTypeStats: async () => [],
    },
    vectors: { searchAnnotations: async () => [] },
    weaveProgress: { whenApplied: async () => {} },
  };
}

describe('specs/src/librarian/window-cases.json', () => {
  it('has a case of each of its two parts, and no case of none', () => {
    const parts = ['around', 'gathered'] as const;
    for (const key of parts) expect(part(key).length, key).toBeGreaterThan(0);
    for (const c of table.cases) expect(parts.filter((key) => c[key]), c.why).toHaveLength(1);
  });

  describe('the text around an annotation that has a position', () => {
    it.each(part('around'))('$why', ({ given }) => {
      const annotation = annotationOf(given.selector);
      const cut = () =>
        AnnotationContext.extractAnnotationContext(annotation, given.text, given.window.before, given.window.after);

      if (given.refused) {
        expect(given.context).toBeUndefined();
        expect(cut).toThrow();
        return;
      }
      expect(given.context).toBeDefined();
      expect(cut()).toEqual(given.context);

      const position = Array.isArray(given.selector) ? null : getTextPositionSelector(given.selector);
      if (position) {
        expect(textAround(given.text, position.start, position.end, given.window.before, given.window.after))
          .toEqual(given.context);
      }
    });
  });

  describe('the text around an annotation in a gathered context', () => {
    it.each(part('gathered'))('$why', async ({ given }) => {
      const annotation = annotationOf(given.selector);
      const gather = AnnotationGather.buildLLMContext(
        ANNOTATION,
        SOURCE,
        storesOf(given.text, annotation),
        createMockEmbeddingProvider(),
        { contextWindow: given.window },
      );

      if (given.refused) {
        expect(given.context).toBeUndefined();
        await expect(gather).rejects.toThrow();
        return;
      }
      expect(given.context).not.toBeUndefined();

      const { focus } = await gather;
      if (focus.kind !== 'annotation') throw new Error('expected an annotation focus');
      const { selected } = focus;
      expect(selected ? { before: selected.before, selected: selected.text, after: selected.after } : null)
        .toEqual(given.context);
    });
  });
});
