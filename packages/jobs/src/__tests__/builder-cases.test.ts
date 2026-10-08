/**
 * The annotation a worker commits, held to
 * specs/src/annotations/builder-cases.json: the table every worker runs, so
 * that a span found in a resource is built into the same annotation whoever
 * builds it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { assembleAnnotation, resourceId, type AnchoredText, type Annotation, type components } from '@semiont/core';
import { buildPdfAnnotation, buildTextAnnotation, type Motivation, type SpanMatch } from '../processors';

type Agent = components['schemas']['Agent'];
type AnnotationBody = components['schemas']['AnnotationBody'];
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];

/** What a case answers: the annotation, less the members no case can state, or the refusal's name. */
type Answer = { annotation: Record<string, unknown> } | { refused: string };

type BuildCase = {
  why: string;
  resourceId: string;
  generator: Agent;
  motivation: Motivation;
  span: SpanMatch;
  body?: Annotation['body'];
} & ({ text: string } | { anchored: AnchoredText }) & Answer;

type RequestCase = {
  why: string;
  request: CreateAnnotationRequest;
  generator?: Agent;
} & ({ annotation: Record<string, unknown>; bodies: AnnotationBody[] } | { refused: string });

const table: {
  unstated: { cases: string[]; requests: string[] };
  cases: BuildCase[];
  requests: RequestCase[];
} = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/builder-cases.json', import.meta.url), 'utf8'),
);

/** How this implementation words each refusal the table names. */
const REFUSALS = new Map<string, RegExp>([
  ['exact-mismatch', /buildTextAnnotation invariant: content\.substring/],
  ['prefix-mismatch', /buildTextAnnotation invariant: content prefix-slice/],
  ['suffix-mismatch', /buildTextAnnotation invariant: content suffix-slice/],
  ['nothing-located', /buildPdfAnnotation invariant: no rects located/],
  ['exact-not-covered', /buildPdfAnnotation invariant: covered text does not contain exact/],
  ['svg-no-namespace', /Invalid SVG markup: SVG must include xmlns/],
  ['svg-no-element', /Invalid SVG markup: SVG must have opening and closing tags/],
  ['svg-no-shape', /Invalid SVG markup: SVG must contain at least one shape element/],
  ['no-motivation', /motivation is required/],
]);

function refusal(name: string): RegExp {
  const worded = REFUSALS.get(name);
  if (worded === undefined) throw new Error(`the table names a refusal this runner has no wording for: ${name}`);
  return worded;
}

/** The annotation with the members the table cannot state taken out, each first checked to be there. */
function stated(annotation: object, unstated: string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...annotation };
  for (const member of unstated) {
    expect(typeof rest[member], member).toBe('string');
    delete rest[member];
  }
  return rest;
}

describe('the annotation a worker commits (specs/src/annotations/builder-cases.json)', () => {
  it('has cases of each kind', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    expect(table.requests.length).toBeGreaterThan(0);
  });

  for (const built of table.cases) {
    it(built.why, () => {
      const build = () =>
        'text' in built
          ? buildTextAnnotation(built.text, resourceId(built.resourceId), built.generator, built.motivation, built.span, built.body)
          : buildPdfAnnotation(built.anchored, resourceId(built.resourceId), built.generator, built.motivation, built.span, built.body);

      if ('refused' in built) {
        expect(build).toThrow(refusal(built.refused));
      } else {
        expect(stated(build(), table.unstated.cases)).toStrictEqual(built.annotation);
      }
    });
  }

  for (const assembled of table.requests) {
    it(assembled.why, () => {
      const assemble = () => assembleAnnotation(assembled.request, assembled.generator);

      if ('refused' in assembled) {
        expect(assemble).toThrow(refusal(assembled.refused));
      } else {
        const { annotation, bodyArray } = assemble();
        // `toEqual`: a member that is there with no value is no member, as on the wire.
        expect(stated(annotation, table.unstated.requests)).toEqual(assembled.annotation);
        expect(bodyArray, 'bodies').toStrictEqual(assembled.bodies);
      }
    });
  }
});
