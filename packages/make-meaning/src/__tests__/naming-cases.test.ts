/**
 * How the people a reply mentions are named, held to
 * specs/src/librarian/naming-cases.json: the table every implementation of
 * the naming runs, so that one reply and one set of profiles give one named
 * reply in any language.
 *
 * That a reply which names no one comes back as the same object is
 * TypeScript's own, and is held by the reader's unit test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validators, formatErrors } from '@semiont/core/openapi';
import { resolvePersonNames, type People } from '../views/people-reader';

interface Case {
  why: string;
  reply: unknown;
  people: People;
  named: unknown;
}

const TABLE = 'specs/src/librarian/naming-cases.json';
const table: { cases: Case[] } = JSON.parse(readFileSync(new URL(`../../../../${TABLE}`, import.meta.url), 'utf8'));

describe('the naming of the people a reply mentions (specs/src/librarian/naming-cases.json)', () => {
  it('has cases that name someone and cases that name no one, each stating a reply, the people and the reply named', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    for (const stated of table.cases) {
      expect(typeof stated.why).toBe('string');
      expect(Object.keys(stated)).toEqual(expect.arrayContaining(['reply', 'people', 'named']));
    }
    const names = (stated: Case): boolean => JSON.stringify(stated.reply) !== JSON.stringify(stated.named);
    expect(table.cases.some(names)).toBe(true);
    expect(table.cases.some((stated) => !names(stated))).toBe(true);
  });

  it('states only people the spec accepts', () => {
    const validate = validators.PeopleProjection;
    for (const stated of table.cases) {
      // A validator may write to what it reads, so it is given a copy.
      const refused = validate({ people: structuredClone(stated.people) }) ? null : formatErrors(validate.errors);
      expect(refused, stated.why).toBeNull();
    }
  });

  it.each(table.cases)('$why', ({ reply, people, named }) => {
    expect(resolvePersonNames(reply, people)).toStrictEqual(named);
  });
});
