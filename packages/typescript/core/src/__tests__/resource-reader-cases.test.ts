/**
 * The readers of a resource's description, held to
 * specs/src/resources/reader-cases.json: the table every SDK's readers run, so
 * that TypeScript, Rust and Python give one answer for one resource.
 *
 * Rust and Python decode each case's resource as the type their SDK has of
 * one, and refuse a resource the schema does not allow. TypeScript reads what
 * it is handed, so here each resource is held to the schema too: a case that
 * only TypeScript could read is found by this run, and a refused case is one
 * the schema does not allow and the readers refuse.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SemiontError } from '../errors';
import type { ResourceDescriptor } from '../graph';
import { formatErrors, validators } from '../openapi';
import { getPrimaryMediaType, getPrimaryRepresentation, getResourceEntityTypes } from '../resource-utils';
import type { components } from '../types';

type Representation = components['schemas']['Representation'];

interface Case {
  why: string;
  resource: ResourceDescriptor;
  primaryRepresentation?: Representation;
  primaryMediaType?: string;
  entityTypes: string[];
}

/** A resource the schema does not allow: the readers refuse it. */
interface Refused {
  why: string;
  resource: ResourceDescriptor;
  refused: true;
}

const table: { cases: (Case | Refused)[] } = JSON.parse(
  readFileSync(new URL('../../../../../specs/src/resources/reader-cases.json', import.meta.url), 'utf8'),
);
const read = table.cases.filter((stated): stated is Case => !('refused' in stated));
const refused = table.cases.filter((stated): stated is Refused => 'refused' in stated);

/** What every case states, what a case of a resource with a representation states besides, and what a refused case states. */
const ALWAYS = ['entityTypes', 'resource', 'why'];
const OF_A_REPRESENTATION = ['primaryMediaType', 'primaryRepresentation'];
const OF_A_REFUSAL = ['refused', 'resource', 'why'];

/** The reading is refused as the reader's own failure, naming the representations. */
function refusedNamingRepresentations(reading: () => unknown, why: string): void {
  let refusal: unknown;
  try {
    reading();
  } catch (thrown) {
    refusal = thrown;
  }
  expect(refusal, why).toBeInstanceOf(SemiontError);
  if (refusal instanceof SemiontError) {
    expect(refusal.code, why).toBe('error');
    expect(refusal.message, why).toContain('representations');
  }
}

describe('the readers of a resource (specs/src/resources/reader-cases.json)', () => {
  it('has cases of a resource with a representation and of one with none, with entity types and with none, and refused ones', () => {
    expect(read.some((stated) => stated.primaryRepresentation !== undefined)).toBe(true);
    expect(read.some((stated) => stated.primaryRepresentation === undefined)).toBe(true);
    expect(read.some((stated) => stated.entityTypes.length > 0)).toBe(true);
    expect(read.some((stated) => stated.entityTypes.length === 0)).toBe(true);
    expect(refused.length).toBeGreaterThan(0);
  });

  it('states in every case what each reader answers, and nothing no reader here reads', () => {
    for (const stated of read) {
      // The representation and its media type are stated together, or neither is.
      const hasOne = OF_A_REPRESENTATION.some((member) => member in stated);
      const expected = hasOne ? [...ALWAYS, ...OF_A_REPRESENTATION].sort() : ALWAYS;
      expect(Object.keys(stated).sort(), stated.why).toEqual(expected);
    }
    for (const stated of refused) {
      expect(Object.keys(stated).sort(), stated.why).toEqual(OF_A_REFUSAL);
      expect(stated.refused, stated.why).toBe(true);
    }
  });

  it('holds every resource to its schema, which allows none that is refused', () => {
    for (const { why, resource } of read) {
      const valid = validators.ResourceDescriptor(resource);
      expect(valid, `${why}: ${formatErrors(validators.ResourceDescriptor.errors)}`).toBe(true);
    }
    for (const { why, resource } of refused) {
      expect(validators.ResourceDescriptor(resource), why).toBe(false);
    }
  });

  for (const { why, resource, primaryRepresentation, primaryMediaType, entityTypes } of read) {
    it(why, () => {
      expect(getPrimaryRepresentation(resource)).toEqual(primaryRepresentation);
      expect(getPrimaryMediaType(resource)).toBe(primaryMediaType);
      expect(getResourceEntityTypes(resource)).toEqual(entityTypes);
    });
  }

  for (const { why, resource } of refused) {
    it(why, () => {
      refusedNamingRepresentations(() => getPrimaryRepresentation(resource), `${why}: getPrimaryRepresentation`);
      refusedNamingRepresentations(() => getPrimaryMediaType(resource), `${why}: getPrimaryMediaType`);
    });
  }
});
