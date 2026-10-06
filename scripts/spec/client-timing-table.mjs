// client-timing-table.mjs — the one reading of specs/src/client/timing.json
// that every generator of it shares: each entry named for what it is (a
// duration, a retry budget, a count), stated once, documented, and a value of
// its kind.

import { readFileSync } from 'node:fs';

/**
 * The entries of the table at `tablePath`, checked. `refuse(message)` is
 * called for a table that cannot be generated from, and does not return.
 */
export function readClientTiming(tablePath, refuse) {
  const whole = (n) => Number.isInteger(n) && n > 0;

  const { timing } = JSON.parse(readFileSync(tablePath, 'utf8'));
  if (!Array.isArray(timing) || timing.length === 0) refuse('lists no timing');

  const seen = new Set();
  for (const entry of timing) {
    const { name, value, docs } = entry;
    if (typeof name !== 'string' || !/^[a-z][A-Za-z]*(Ms|Retry|Count)$/.test(name)) {
      refuse(`${JSON.stringify(name)} is not a name: camelCase, ending in Ms for a duration, Retry for a budget or Count for a count`);
    }
    if (seen.has(name)) refuse(`${name} is stated twice`);
    seen.add(name);
    if (typeof docs !== 'string' || docs === '') refuse(`${name} has no docs`);
    if (name.endsWith('Ms')) {
      if (!whole(value)) refuse(`${name} is a duration, so its value is a whole number of milliseconds above zero`);
      continue;
    }
    if (name.endsWith('Count')) {
      if (!whole(value)) refuse(`${name} is a count, so its value is a whole number above zero`);
      continue;
    }
    const fields = value === null || typeof value !== 'object' ? [] : Object.keys(value).sort();
    if (fields.join() !== 'attempts,initialDelayMs,maxDelayMs') {
      refuse(`${name} is a budget, so its value is exactly attempts, initialDelayMs and maxDelayMs`);
    }
    if (!Number.isInteger(value.attempts) || value.attempts < 1) refuse(`${name} allows no attempt`);
    if (!whole(value.initialDelayMs) || !whole(value.maxDelayMs)) {
      refuse(`${name}'s delays are whole numbers of milliseconds above zero`);
    }
    if (value.initialDelayMs > value.maxDelayMs) refuse(`${name}'s backoff starts above its ceiling`);
  }

  return timing;
}
