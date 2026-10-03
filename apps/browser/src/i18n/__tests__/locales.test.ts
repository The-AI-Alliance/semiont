/**
 * The Browser supports react-ui's `AVAILABLE_LOCALES` and serves each one from
 * `messages-source/<code>.json` merged over react-ui's translations. A locale
 * react-ui gains with no Browser file would be served with react-ui's strings
 * alone, and every Browser string in it would render as its key.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { AVAILABLE_LOCALES } from '@semiont/react-ui';

describe('Browser messages', () => {
  it('exist for exactly the locales react-ui translates', () => {
    const translated = readdirSync(resolve(process.cwd(), 'messages-source'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => basename(file, '.json'))
      .sort();

    expect(translated).toEqual([...AVAILABLE_LOCALES].sort());
  });
});
