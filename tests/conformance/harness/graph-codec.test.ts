/**
 * The harness's reading of the graph, held to
 * specs/src/graph/codec-cases.json: the table every implementation of the
 * graph's codecs runs, the Weaver's among them. It is what makes
 * harness/graph-codec.ts a reader a Weaver can be judged by.
 *
 * The harness reads the graph and writes nothing to it, so it runs the parts
 * a reader has: a row read as an annotation, a row read as a resource, and
 * what the graph is meant to hold of an annotation the record holds. The
 * parts that are a writer's (the row an annotation is stored as, an
 * annotation updated, a reference resolved, a resource stored) are run by the
 * writer's codec.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Annotation, ResourceDescriptor } from '@semiont/core';
import { formatErrors, validators } from '@semiont/core/openapi';
import { intendedGraphAnnotation, isRow, isStrings, readAnnotation, readResource, type Row } from './graph-codec';
import { SPEC_SOURCE } from './paths';

const TABLE = 'graph/codec-cases.json';
const PARTS = ['annotationStored', 'annotationRead', 'annotationUpdated', 'referenceResolved', 'resourceStored', 'resourceRead'] as const;

/** A case as the table gives it: why it is there, and its part. Nothing else in it is trusted until it is read. */
interface Case {
  why: string;
  fields: Row;
}

function cases(): Case[] {
  const table: unknown = JSON.parse(readFileSync(join(SPEC_SOURCE, TABLE), 'utf8'));
  if (!isRow(table) || !Array.isArray(table['cases'])) throw new Error(`${TABLE} has no cases`);
  return table['cases'].map((one: unknown) => {
    if (!isRow(one) || typeof one['why'] !== 'string') throw new Error(`${TABLE}: a case is malformed: ${JSON.stringify(one)}`);
    return { why: one['why'], fields: one };
  });
}

const table = cases();

/** The cases of one part, each read by `read` from what the table gives under the part's name. */
function part<Given>(key: (typeof PARTS)[number], read: (why: string, given: Row) => Given): Array<{ why: string; given: Given }> {
  return table.flatMap(({ why, fields }) => {
    const given = fields[key];
    if (given === undefined) return [];
    if (!isRow(given)) throw new Error(`${TABLE}: "${why}" gives ${key} as something other than an object`);
    return [{ why, given: read(why, given) }];
  });
}

function annotation(why: string, value: unknown): Annotation {
  if (!validators.Annotation(value)) throw new Error(`${TABLE}: "${why}" gives an annotation the spec does not allow: ${formatErrors(validators.Annotation.errors)}`);
  return value;
}

/**
 * An annotation as the record gives it. The table gives one with an empty
 * body, to say that nothing is stored for it; the spec's Annotation has no
 * empty body, so that one is held to the spec without it.
 */
function recorded(why: string, value: unknown): Annotation {
  if (!isRow(value) || !Array.isArray(value['body']) || value['body'].length > 0) return annotation(why, value);
  const { body: _empty, ...rest } = value;
  return { ...annotation(why, rest), body: [] };
}

function resource(why: string, value: unknown): ResourceDescriptor {
  if (!validators.ResourceDescriptor(value)) throw new Error(`${TABLE}: "${why}" gives a resource the spec does not allow: ${formatErrors(validators.ResourceDescriptor.errors)}`);
  return value;
}

function properties(why: string, value: unknown): Row {
  if (!isRow(value)) throw new Error(`${TABLE}: "${why}" gives no properties`);
  return value;
}

/** The word a refusal must name, where the case is one. */
function refused(why: string, value: unknown): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  throw new Error(`${TABLE}: "${why}" gives a refusal that is not a word`);
}

const annotationStored = part('annotationStored', (why, given) => ({ annotation: recorded(why, given['annotation']), holds: annotation(why, given['holds']) }));

const annotationRead = part('annotationRead', (why, given) => {
  const tags = given['tags'];
  if (!isStrings(tags)) throw new Error(`${TABLE}: "${why}" gives no tags`);
  const word = refused(why, given['refused']);
  return { properties: properties(why, given['properties']), tags, annotation: word === undefined ? annotation(why, given['annotation']) : undefined, refused: word };
});

const resourceRead = part('resourceRead', (why, given) => {
  const word = refused(why, given['refused']);
  return { properties: properties(why, given['properties']), resource: word === undefined ? resource(why, given['resource']) : undefined, refused: word };
});

describe('the graph, as the harness reads it', () => {
  it('is held to a table whose every case is of one part, with cases of each part read here', () => {
    for (const one of table) expect(PARTS.filter((key) => one.fields[key] !== undefined), one.why).toHaveLength(1);
    expect(annotationStored.length, 'annotationStored').toBeGreaterThan(0);
    expect(annotationRead.length, 'annotationRead').toBeGreaterThan(0);
    expect(resourceRead.length, 'resourceRead').toBeGreaterThan(0);
  });

  describe('what the graph is meant to hold of an annotation', () => {
    it.each(annotationStored)('$why', ({ given }) => {
      expect(intendedGraphAnnotation(given.annotation)).toEqual(given.holds);
    });
  });

  describe("an annotation's row, read", () => {
    it.each(annotationRead)('$why', ({ given }) => {
      if (given.refused !== undefined) expect(() => readAnnotation(given.properties, given.tags)).toThrow(given.refused);
      else expect(readAnnotation(given.properties, given.tags)).toEqual(given.annotation);
    });
  });

  describe("a resource's row, read", () => {
    it.each(resourceRead)('$why', ({ given }) => {
      if (given.refused !== undefined) expect(() => readResource(given.properties)).toThrow(given.refused);
      else expect(readResource(given.properties)).toEqual(given.resource);
    });
  });
});
