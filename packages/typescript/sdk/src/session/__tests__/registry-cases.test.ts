/**
 * When a registry takes two endpoints for one place, and the order it shows
 * the resources open in a knowledge base in: two tables,
 * protocol/specs/src/session/registry-cases.json, run by every SDK.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resourceId, type KbEndpoint } from '@semiont/core';
import { sortOpenResources, type OpenResource } from '../open-resource';
import { samePlace } from '../semiont-browser';

interface RegistryCase {
  why: string;
  one: KbEndpoint;
  other: KbEndpoint;
  samePlace: boolean;
}

interface OrderCase {
  why: string;
  open: (Omit<OpenResource, 'id'> & { id: string })[];
  shown: string[];
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../protocol/specs/src/session/registry-cases.json');
const { cases, openResourceOrder } = JSON.parse(readFileSync(TABLE, 'utf-8')) as {
  cases: RegistryCase[];
  openResourceOrder: OrderCase[];
};

describe('one place, as the shared table states it', () => {
  it.each(cases)('$why', ({ one, other, samePlace: same }) => {
    expect(samePlace(one, other)).toBe(same);
    expect(samePlace(other, one)).toBe(same);
  });
});

describe('the order open resources are shown in, as the shared table states it', () => {
  it.each(openResourceOrder)('$why', ({ open, shown }) => {
    const kept = open.map((entry) => ({ ...entry, id: resourceId(entry.id) }));
    expect(sortOpenResources(kept).map((entry) => entry.id)).toEqual(shown);
  });
});
