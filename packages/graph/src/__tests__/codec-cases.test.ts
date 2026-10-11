/**
 * The graph's two codecs, held to specs/src/graph/codec-cases.json: the table
 * every implementation of them runs, so that what the graph stores of an
 * annotation and of a resource, what it reads back and what it refuses are
 * stated once and not once per language.
 *
 * This package reads the graph and does not write it, so it runs the parts a
 * reader has: what an annotation is stored as and read back as, a row read,
 * and a resource row read. The parts that are the writer's alone (an
 * annotation updated, a reference resolved, a resource stored) are run by the
 * writer's codec, in packages/graph-python.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getBodySource, getEntityTypes } from '@semiont/core';
import type { Annotation, ResourceDescriptor } from '@semiont/core';
import { decodeAnnotation, encodeAnnotation, intendedGraphAnnotation, type AnnotationProperties } from '../annotation-codec';
import { decodeResource, type StoredResourceProperties } from '../resource-codec';

type Json = Record<string, unknown>;

interface Case {
  why: string;
  annotationStored?: {
    annotation: Annotation;
    properties: Record<string, string>;
    json: Json;
    tags: string[];
    linksTo: string | null;
    holds: Annotation;
  };
  annotationRead?: { properties: AnnotationProperties; tags: string[]; annotation?: Annotation; refused?: string };
  annotationUpdated?: Json;
  referenceResolved?: Json;
  resourceStored?: Json;
  resourceRead?: { properties: StoredResourceProperties; resource?: ResourceDescriptor; refused?: string };
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/graph/codec-cases.json', import.meta.url), 'utf8'),
);

/**
 * A stored bag, as the table states one: the properties that are plain values
 * as they are, and each that is JSON as the value its string parses to. A
 * serializer is free in its spacing and key order, and the table holds it to
 * neither.
 */
function stated(stored: Json, jsonKeys: string[]): { properties: Json; json: Json } {
  const properties: Json = {};
  const json: Json = {};
  for (const [key, value] of Object.entries(stored)) {
    if (jsonKeys.includes(key)) json[key] = JSON.parse(value as string);
    else properties[key] = value;
  }
  return { properties, json };
}

const part = <K extends keyof Case>(key: K) =>
  table.cases.flatMap((c) => (c[key] ? [{ why: c.why, given: c[key] as NonNullable<Case[K]> }] : []));

describe('specs/src/graph/codec-cases.json', () => {
  it('has a case of each of its six parts, and no case of none', () => {
    const parts = ['annotationStored', 'annotationRead', 'annotationUpdated', 'referenceResolved', 'resourceStored', 'resourceRead'] as const;
    for (const key of parts) expect(part(key).length, key).toBeGreaterThan(0);
    for (const c of table.cases) expect(parts.filter((key) => c[key]), c.why).toHaveLength(1);
  });

  describe('an annotation, stored', () => {
    it.each(part('annotationStored'))('$why', ({ given }) => {
      const stored = encodeAnnotation(given.annotation);

      expect(stated(stored, Object.keys(given.json))).toEqual({ properties: given.properties, json: given.json });
      expect([...getEntityTypes(given.annotation)].sort()).toEqual([...given.tags].sort());
      expect(getBodySource(given.annotation.body)).toBe(given.linksTo);
      expect(intendedGraphAnnotation(given.annotation)).toEqual(given.holds);
      expect(decodeAnnotation(stored, given.tags)).toEqual(given.holds);
    });
  });

  describe('a row, read', () => {
    it.each(part('annotationRead'))('$why', ({ given }) => {
      if (given.refused !== undefined) {
        expect(() => decodeAnnotation(given.properties, given.tags)).toThrow(given.refused);
      } else {
        expect(decodeAnnotation(given.properties, given.tags)).toEqual(given.annotation);
      }
    });
  });

  describe('a resource row, read', () => {
    it.each(part('resourceRead'))('$why', ({ given }) => {
      if (given.refused !== undefined) {
        expect(() => decodeResource(given.properties)).toThrow(given.refused);
      } else {
        expect(decodeResource(given.properties)).toEqual(given.resource);
      }
    });
  });
});
