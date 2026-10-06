/**
 * A tree written before (ARCHIVIST.md § The record on disk): the knowledge
 * base in fixtures/typescript-tree was written by the Archivist's first
 * implementation, in TypeScript, and is kept as it was left. An Archivist
 * serves it, rebuilds from its log the very views it was left with, and goes
 * on from it.
 */
import { cpSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { withArchivist } from '../harness/archivist-world';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/typescript-tree');

/** Every file under `dir`, by its path from there, with its bytes. */
function files(dir: string, from = ''): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = from === '' ? entry.name : `${from}/${entry.name}`;
    if (entry.isDirectory()) for (const [inner, bytes] of files(join(dir, entry.name), name)) found.set(inner, bytes);
    else found.set(name, readFileSync(join(dir, entry.name), 'utf8'));
  }
  return found;
}

const SHARED = '75cac8fed07641da9a9423a65108a2ce';
const COPY = '84660af034bb49b781d3904fde93f562';

withArchivist('a tree written before', (world) => {
  it('is rebuilt from its log into the views it was left with, byte for byte', () => {
    const left = files(join(FIXTURE, 'state'));
    expect(left.size).toBe(7);
    const rebuilt = world().stateFiles();
    expect([...rebuilt.keys()].sort()).toEqual([...left.keys()].sort());
    for (const [name, bytes] of left) expect(rebuilt.get(name), name).toBe(bytes);
  });

  it('is served as it was recorded', async () => {
    const reader = await world().person('reader');
    const listed = (await reader.ask('browse:resources-requested', {}))['resources'] as Array<{ '@id': string; name: string; archived: boolean }>;
    expect(listed.map((r) => [r['@id'], r.name, r.archived]).sort()).toEqual([[SHARED, 'Shared', false], [COPY, 'A copy', true]].sort());

    const shared = await reader.ask('browse:resource-requested', { resourceId: SHARED });
    expect(shared).toMatchObject({ resource: { entityTypes: ['Event'], dateModified: expect.any(String) } });
    expect((shared['annotations'] as unknown[])).toHaveLength(1);
    expect((shared['entityReferences'] as unknown[])).toHaveLength(1);

    const replay = await world().http('GET', `/events/${SHARED}?fromSequence=1`, { route: '/events/{resourceId}' });
    const lines = readFileSync(join(FIXTURE, 'kb/.semiont/events/66/9b', SHARED, 'events-000001.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect((replay.json as { events: unknown[] }).events).toEqual(lines.map((line) => JSON.parse(line)));

    const content = await world().http('GET', `/resources/${SHARED}/content`, { route: '/resources/{id}/content' });
    expect(content.text).toBe(readFileSync(join(FIXTURE, 'kb/shared/résumé 📚.md'), 'utf8'));
    expect((await reader.ask('browse:entity-types-requested', {}))['entityTypes']).toContain('Élan');
  });

  it('is gone on from: each stream numbered on from where it was left, and nothing seeded twice', async () => {
    const before = world().stored(SHARED).length;
    const system = world().stored('__system__');
    expect(system.filter((e) => e.type === 'frame:entity-type-added' && e.payload['entityType'] === 'Person')).toHaveLength(1);

    const editor = await world().person('editor');
    await editor.ask('mark:archive', { resourceId: SHARED });
    const events = world().stored(SHARED);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ type: 'mark:archived', metadata: { sequenceNumber: before + 1 } });
    expect(world().view(SHARED)).toMatchObject({ lastSequence: before + 1, resource: { archived: true } });
    // What was there is as it was.
    expect(world().streamLines(SHARED).slice(0, before)).toEqual(
      readFileSync(join(FIXTURE, 'kb/.semiont/events/66/9b', SHARED, 'events-000001.jsonl'), 'utf8').split('\n').filter(Boolean),
    );
  });
}, { gitSync: false, before: (dirs) => cpSync(join(FIXTURE, 'kb'), dirs.root, { recursive: true }) });
