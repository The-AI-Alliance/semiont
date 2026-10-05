/**
 * Where a key is filed must come out the same from every implementation that
 * writes or reads the record's files. The shared table is the agreement; this
 * runs the TypeScript reading of it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getShardPath } from '../shard-utils';

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/archivist/shard-cases.json');
const { cases }: { cases: { why: string; key: string; shard: string }[] } = JSON.parse(readFileSync(TABLE, 'utf8'));

describe('getShardPath agrees with the shared table', () => {
  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('$why', ({ key, shard }) => {
    expect(getShardPath(key).join('/')).toBe(shard);
  });
});
