/**
 * InMemorySessionStorage — text under a key, kept in memory, which no other
 * context writes.
 */

import { describe, it, expect } from 'vitest';
import { InMemorySessionStorage } from '../session-storage';

describe('InMemorySessionStorage', () => {
  it('changes a value as one step: the change is given what is stored and says what is stored next', () => {
    const storage = new InMemorySessionStorage();
    storage.set('k', 'before');
    const given: Array<string | null> = [];

    storage.update('k', (stored) => {
      given.push(stored);
      return `${stored}-after`;
    });

    expect(given).toEqual(['before']);
    expect(storage.get('k')).toBe('before-after');
  });

  it('gives a change null when nothing is stored, and stores nothing when the change says null', () => {
    const storage = new InMemorySessionStorage();
    const given: Array<string | null> = [];

    storage.update('k', (stored) => {
      given.push(stored);
      return 'written';
    });
    storage.update('k', () => null);

    expect(given).toEqual([null]);
    expect(storage.get('k')).toBeNull();
  });

  it('has no other context to hear: subscribe answers null', () => {
    const storage = new InMemorySessionStorage();
    expect(storage.subscribe(() => {})).toBeNull();
  });
});
