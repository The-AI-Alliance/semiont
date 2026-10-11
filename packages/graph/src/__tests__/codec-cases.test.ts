/**
 * The graph's two codecs, held to specs/src/graph/codec-cases.json: the table
 * every implementation of them runs, so that what the graph stores of an
 * annotation and of a resource, what it reads back and what it refuses are
 * stated once and not once per language.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getBodySource, getEntityTypes } from '@semiont/core';
import type { Annotation, ResourceDescriptor, ResourceId } from '@semiont/core';
import {
  buildAnnotation,
  decodeAnnotation,
  encodeAnnotation,
  intendedGraphAnnotation,
  resolvedBody,
  updatedAnnotation,
  type AnnotationProperties,
} from '../annotation-codec';
import { decodeResource, encodeResource, type StoredResourceProperties } from '../resource-codec';

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
  annotationUpdated?: { current: Annotation; updates: Partial<Annotation>; annotation?: Annotation; refused?: string };
  referenceResolved?: { current: Annotation; source: ResourceId; body: Annotation['body'] };
  resourceStored?: { resource: ResourceDescriptor; properties?: Json; json?: Json; holds?: ResourceDescriptor; refused?: string };
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

      // A store is given an annotation to create, and builds what it stores
      // from that. What it builds stores as the same row: a builder that
      // leaves out a field the encoder writes makes a graph that disagrees
      // with the record from the first write.
      const { creator } = given.annotation;
      if (!creator) throw new Error('an annotation the graph is given has a creator');
      expect(encodeAnnotation(buildAnnotation({ ...given.annotation, creator }))).toEqual(stored);
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

  describe('an annotation, updated', () => {
    it.each(part('annotationUpdated'))('$why', ({ given }) => {
      if (given.refused !== undefined) {
        expect(() => updatedAnnotation(given.current, given.updates)).toThrow(given.refused);
      } else {
        expect(updatedAnnotation(given.current, given.updates)).toEqual(given.annotation);
      }
    });
  });

  describe('a reference, resolved', () => {
    it.each(part('referenceResolved'))('$why', ({ given }) => {
      expect(resolvedBody(given.current, given.source)).toEqual(given.body);
    });
  });

  describe('a resource, stored', () => {
    it.each(part('resourceStored'))('$why', ({ given }) => {
      if (given.refused !== undefined) {
        expect(() => encodeResource(given.resource)).toThrow(given.refused);
        return;
      }
      const stored = encodeResource(given.resource);

      expect(stated({ ...stored }, Object.keys(given.json ?? {}))).toEqual({ properties: given.properties, json: given.json });
      expect(decodeResource(stored)).toEqual(given.holds);
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
