/**
 * What a bus log shows of a payload, held to specs/src/bus/log-cases.json:
 * the table every bus log runs. No line holds a credential: the value of a
 * member whose name is one of the table's `names` is withheld, and nothing
 * else of a line changes.
 *
 * `busLog` writes with `console.debug(tag, payload)`, so what it shows of a
 * payload is the second thing it hands the console.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { busLog } from '../bus-log';
import { isObject } from '../type-guards';

interface Case { why: string; payload: unknown; shown: unknown }

const TABLE = 'specs/src/bus/log-cases.json';
const table: { names: string[]; cases: Case[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../../..', TABLE), 'utf8'));

// The rule reads a name and no channel: every line here is written on this one.
const CHANNEL = 'yield:clone-create';
const TAG = `[bus EMIT] ${CHANNEL}`;

const flag = globalThis as { __SEMIONT_BUS_LOG__?: boolean };
let saved: boolean | undefined;
let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = flag.__SEMIONT_BUS_LOG__;
  flag.__SEMIONT_BUS_LOG__ = true;
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  if (saved === undefined) delete flag.__SEMIONT_BUS_LOG__;
  else flag.__SEMIONT_BUS_LOG__ = saved;
  debug.mockRestore();
});

/** What the one line written showed of its payload. */
function shownOf(payload: unknown): unknown {
  busLog('EMIT', CHANNEL, payload);
  expect(debug).toHaveBeenCalledTimes(1);
  const [tag, shown] = debug.mock.calls[0] ?? [];
  expect(tag).toBe(TAG);
  return shown;
}

/** `value`, which is an object: one whose members a test goes on to read. */
function members(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`not an object: ${String(value)}`);
  return value;
}

describe('what a bus log shows of a payload (specs/src/bus/log-cases.json)', () => {
  it('has names, and cases that carry a credential and cases that carry none, each stating a payload and what is shown of it', () => {
    expect(table.names.length).toBeGreaterThan(0);
    expect(new Set(table.names).size).toBe(table.names.length);
    expect(table.cases.length).toBeGreaterThan(0);
    for (const stated of table.cases) {
      expect(typeof stated.why).toBe('string');
      expect(Object.keys(stated)).toEqual(expect.arrayContaining(['payload', 'shown']));
    }
    const carries = (stated: Case): boolean => JSON.stringify(stated.payload) !== JSON.stringify(stated.shown);
    expect(table.cases.some(carries)).toBe(true);
    expect(table.cases.some((stated) => !carries(stated))).toBe(true);
  });

  it.each(table.cases)('$why', ({ payload, shown }) => {
    expect(shownOf(payload)).toStrictEqual(shown);
  });

  // The names this log withholds under are its own list, and the table's is the one it is held to.
  it.each(table.names)('withholds the value of a member named %s, and shows the member beside it', (name) => {
    expect(shownOf({ [name]: 'a-credential', beside: 'shown' })).toStrictEqual({ [name]: '[withheld]', beside: 'shown' });
  });
});

// What only a JavaScript value can be, and so is no case of the table: a
// payload that is no frame's, one that is no JSON, and the payload itself,
// which a bus goes on to deliver.
describe('what busLog shows of a payload that is no frame\'s, or no JSON', () => {
  it('leaves the payload it is given as it was: a subscriber is still handed the token', () => {
    const payload = { token: 'clone-token', response: { token: 'clone-token' }, clones: [{ token: 'clone-token' }] };
    const before = structuredClone(payload);
    const shown = shownOf(payload);
    expect(payload).toStrictEqual(before);
    expect(shown).toStrictEqual({ token: '[withheld]', response: { token: '[withheld]' }, clones: [{ token: '[withheld]' }] });
  });

  it('reads a payload that is an array by the same rule', () => {
    expect(shownOf([{ token: 'clone-token', name: 'first' }, 'token', ['token']])).toStrictEqual([
      { token: '[withheld]', name: 'first' },
      'token',
      ['token'],
    ]);
  });

  it.each([['text, though it is the word', 'token'], ['a number', 7], ['null', null], ['nothing', undefined]])(
    'shows a payload that is %s as it is',
    (_what, payload) => {
      expect(shownOf(payload)).toBe(payload);
    },
  );

  it('shows what is neither an array nor a plain object as it is: itself, and no copy of it', () => {
    class Rectangle {
      width = 3;
      height = 4;
    }
    const when = new Date(0);
    const anchorRect = new Rectangle();
    const cancelFallback = (): void => {};
    const shown = members(shownOf({ token: 'clone-token', when, anchorRect, cancelFallback }));
    expect(shown.token).toBe('[withheld]');
    expect(shown.when).toBe(when);
    expect(shown.anchorRect).toBe(anchorRect);
    expect(shown.cancelFallback).toBe(cancelFallback);
  });

  it('reads an object that has no prototype as the plain object it is', () => {
    const payload = { __proto__: null, token: 'clone-token', name: 'A clone' };
    expect(Object.getPrototypeOf(payload)).toBeNull();
    expect({ ...members(shownOf(payload)) }).toStrictEqual({ token: '[withheld]', name: 'A clone' });
  });

  it('shows a payload that holds itself once, with its token withheld wherever it comes round', () => {
    const payload: Record<string, unknown> = { token: 'clone-token' };
    payload.itself = payload;
    payload.listed = [payload];
    const shown = members(shownOf(payload));
    expect(shown.token).toBe('[withheld]');
    expect(shown.itself).toBe(shown);
    expect(shown.listed).toStrictEqual([shown]);
  });

  it('shows a member named __proto__, which JSON may carry, as the member it is', () => {
    const payload: unknown = JSON.parse('{"__proto__":{"token":"clone-token"},"name":"A clone"}');
    const shown = members(shownOf(payload));
    expect(Object.keys(shown)).toEqual(['__proto__', 'name']);
    expect(Object.getPrototypeOf(shown)).toBe(Object.prototype);
    expect(JSON.stringify(shown)).toBe('{"__proto__":{"token":"[withheld]"},"name":"A clone"}');
  });
});
