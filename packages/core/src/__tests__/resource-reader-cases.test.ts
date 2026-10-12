/**
 * The readers of a resource's description, held to
 * specs/src/resources/reader-cases.json: the table every SDK's readers run, so
 * that TypeScript, Rust and Python give one answer for one resource.
 *
 * Rust and Python decode each case's resource as the type their SDK has of
 * one, and refuse a resource the schema does not allow. TypeScript reads what
 * it is handed, so here each resource is held to the schema too: a case that
 * only TypeScript could read is found by this run.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/resources/reader-cases.json', import.meta.url), 'utf8'),
);

/** What every case states, and what a case of a resource with a representation states besides. */
const ALWAYS = ['entityTypes', 'resource', 'why'];
const OF_A_REPRESENTATION = ['primaryMediaType', 'primaryRepresentation'];

describe('the readers of a resource (specs/src/resources/reader-cases.json)', () => {
  it('has cases of a resource with a representation and of one with none, with entity types and with none', () => {
    expect(table.cases.some((stated) => stated.primaryRepresentation !== undefined)).toBe(true);
    expect(table.cases.some((stated) => stated.primaryRepresentation === undefined)).toBe(true);
    expect(table.cases.some((stated) => stated.entityTypes.length > 0)).toBe(true);
    expect(table.cases.some((stated) => stated.entityTypes.length === 0)).toBe(true);
  });

  it('states in every case what each reader answers, and nothing no reader here reads', () => {
    for (const stated of table.cases) {
      // The representation and its media type are stated together, or neither is.
      const hasOne = OF_A_REPRESENTATION.some((member) => member in stated);
      const expected = hasOne ? [...ALWAYS, ...OF_A_REPRESENTATION].sort() : ALWAYS;
      expect(Object.keys(stated).sort(), stated.why).toEqual(expected);
    }
  });

  it('holds every resource to its schema', () => {
    for (const { why, resource } of table.cases) {
      const valid = validators.ResourceDescriptor(resource);
      expect(valid, `${why}: ${formatErrors(validators.ResourceDescriptor.errors)}`).toBe(true);
    }
  });

  for (const { why, resource, primaryRepresentation, primaryMediaType, entityTypes } of table.cases) {
    it(why, () => {
      expect(getPrimaryRepresentation(resource)).toEqual(primaryRepresentation);
      expect(getPrimaryMediaType(resource)).toBe(primaryMediaType);
      expect(getResourceEntityTypes(resource)).toEqual(entityTypes);
    });
  }
});
