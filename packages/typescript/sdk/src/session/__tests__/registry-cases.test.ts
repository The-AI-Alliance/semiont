/**
 * When a registry takes two endpoints for one place: one table,
 * protocol/specs/src/session/registry-cases.json, run by every SDK.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { KbEndpoint } from '@semiont/core';
import { samePlace } from '../semiont-browser';

interface RegistryCase {
  why: string;
  one: KbEndpoint;
  other: KbEndpoint;
  samePlace: boolean;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../protocol/specs/src/session/registry-cases.json');
const { cases } = JSON.parse(readFileSync(TABLE, 'utf-8')) as { cases: RegistryCase[] };

describe('one place, as the shared table states it', () => {
  it.each(cases)('$why', ({ one, other, samePlace: same }) => {
    expect(samePlace(one, other)).toBe(same);
    expect(samePlace(other, one)).toBe(same);
  });
});
