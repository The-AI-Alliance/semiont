/**
 * An id is typed by where it comes from: the spec's generated types carry the
 * brands, so a value read from a claimed job, a reply or an event is already
 * one. A cast to an id's kind says a value is an id without anything having
 * made it one — `'' as ResourceId` typechecks and is not an id. Source-level
 * on purpose: the compiler accepts every such cast, so only the source can say
 * there is none. The kinds are read from the spec's table, so a fifth is held
 * the day it is named.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');
const KINDS = join(__dirname, '..', '..', '..', '..', 'specs', 'src', 'identifiers', 'kinds.json');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('no id is made by a cast', () => {
  const { kinds } = JSON.parse(readFileSync(KINDS, 'utf-8')) as { kinds: { schema: string }[] };
  const names = kinds.map((kind) => kind.schema);

  it('reads the kinds from the spec', () => {
    expect(names).toContain('ResourceId');
    expect(names.length).toBeGreaterThanOrEqual(4);
  });

  it('nothing under src, outside tests, casts a value to an id kind', () => {
    const cast = new RegExp(`\\bas (${names.join('|')})\\b`);
    const files = sources(SRC);
    expect(files.length, 'the walk found no sources — the gate would pass on nothing').toBeGreaterThan(10);
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf-8')
        .split('\n')
        .flatMap((line, i) => (cast.test(line) ? [`${relative(SRC, file)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
