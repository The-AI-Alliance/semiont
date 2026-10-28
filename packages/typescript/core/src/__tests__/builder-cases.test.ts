/**
 * The annotation builders, held to specs/src/annotations/builder-cases.json:
 * the table every SDK's builders run, so that a span found in a resource, and
 * a resource as a whole, are built into the same annotation whoever builds it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as builders from '../annotation-builders';
import { annotationOfResource, annotationOfSpan, SpanRefusedError, type TextSpan } from '../annotation-builders';
import type { Annotation } from '../annotation-types';
import type { Motivation } from '../branded-types';
import { resourceId } from '../identifiers';
import type { AnchoredText } from '../pdf-anchoring';
import type { components } from '../types';

type Agent = components['schemas']['Agent'];

/** What a case of a span answers: the annotation, less the members no case can state, or the refusal's name. */
type Answer = { annotation: Record<string, unknown> } | { refused: string };

type SpanCase = {
  why: string;
  resourceId: string;
  generator: Agent;
  motivation: Motivation;
  span: TextSpan;
  body?: Annotation['body'];
} & ({ text: string } | { anchored: AnchoredText }) & Answer;

interface ResourceCase {
  why: string;
  resourceId: string;
  motivation: Motivation;
  generator?: Agent;
  body?: Annotation['body'];
  annotation: Record<string, unknown>;
}

const table: {
  unstated: { cases: string[]; resources: string[] };
  builders: string[];
  cases: SpanCase[];
  resources: ResourceCase[];
} = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/builder-cases.json', import.meta.url), 'utf8'),
);

/**
 * Every refusal a builder can give: the `spanRefusal` codes of
 * specs/src/errors/codes.json, which `SpanRefusal`, the type of a refusal's
 * `code`, is generated from.
 */
const REFUSALS: string[] = (
  JSON.parse(readFileSync(new URL('../../../../specs/src/errors/codes.json', import.meta.url), 'utf8')) as {
    spanRefusal: { codes: Array<{ code: string }> };
  }
).spanRefusal.codes.map((entry) => entry.code);

/** The annotation with the members the table cannot state taken out, each first checked to be an instant. */
function stated(annotation: Annotation, unstated: string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...annotation };
  for (const member of unstated) {
    const at = rest[member];
    expect(typeof at === 'string' && new Date(at).toISOString() === at, `${member}: ${String(at)}`).toBe(true);
    delete rest[member];
  }
  return rest;
}

/** What a builder threw, which a refused case requires it to. */
function thrownBy(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  throw new Error('the builder refused nothing');
}

describe('the annotation builders (specs/src/annotations/builder-cases.json)', () => {
  it('are the ones the table names, and the module has nothing else but the error a refused span is', () => {
    expect(Object.keys(builders).sort()).toEqual([...table.builders, 'SpanRefusedError'].sort());
  });

  it('has cases of each kind', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    expect(table.resources.length).toBeGreaterThan(0);
  });

  it('can give the refusals the cases name, and no other', () => {
    const named = new Set(table.cases.flatMap((built) => ('refused' in built ? [built.refused] : [])));
    expect([...named].sort()).toEqual([...REFUSALS].sort());
  });

  for (const built of table.cases) {
    it(built.why, () => {
      const { resourceId: id, generator, motivation, span, body } = built;
      const of = { resourceId: resourceId(id), generator, motivation, span, ...(body !== undefined ? { body } : {}) };
      const build = () =>
        'text' in built ? annotationOfSpan({ ...of, text: built.text }) : annotationOfSpan({ ...of, anchored: built.anchored });

      if ('refused' in built) {
        const refusal = thrownBy(build);
        expect(refusal).toBeInstanceOf(SpanRefusedError);
        expect((refusal as SpanRefusedError).code).toBe(built.refused);
      } else {
        expect(stated(build(), table.unstated.cases)).toStrictEqual(built.annotation);
      }
    });
  }

  for (const built of table.resources) {
    it(built.why, () => {
      const { resourceId: id, motivation, generator, body } = built;
      const annotation = annotationOfResource({
        resourceId: resourceId(id),
        motivation,
        ...(generator !== undefined ? { generator } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      expect(stated(annotation, table.unstated.resources)).toStrictEqual(built.annotation);
    });
  }
});
