/**
 * The record across restarts (ARCHIVIST.md § The record on disk, § Boot and
 * shutdown): what survives, what is rebuilt, what is reaped, and how a log
 * written before is read.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { highlight, shardCases, shardOf, withArchivist, type ArchivistWorld } from '../harness/archivist-world';

const TEXT = 'The record survives the process that keeps it.\n';

async function annotated(world: ArchivistWorld, name: string): Promise<{ id: string; annotationId: string }> {
  const id = await world.created(world.world.personDid('ada'), { name, storageUri: `file://survives/${name.replaceAll(' ', '-')}.md`, content: TEXT });
  const grace = await world.person('grace');
  const { annotationId } = (await grace.ask('mark:create-request', { resourceId: id, request: highlight(id, 'record', 4) })) as { annotationId: string };
  return { id, annotationId };
}

withArchivist('the record, across restarts', (world) => {
  it('agrees with the shard table', () => {
    for (const { key, shard } of shardCases()) expect(shardOf(key), key).toBe(shard);
  });

  it('numbers a stream on from where it stopped, after a stop and after a crash', async () => {
    const { id } = await annotated(world(), 'numbered');
    const editor = async () => world().person('editor');

    await world().restart();
    await (await editor()).ask('mark:archive', { resourceId: id });
    await world().crashAndRestart();
    await (await editor()).ask('mark:unarchive', { resourceId: id });

    expect(world().stored(id).map((e) => [e.type, e.metadata.sequenceNumber])).toEqual([['yield:created', 1], ['mark:added', 2], ['mark:archived', 3], ['mark:unarchived', 4]]);
    expect(world().streamFiles(id)).toEqual(['events-000001.jsonl']);
    expect(world().view(id)).toMatchObject({ lastSequence: 4, resource: { archived: false }, annotations: { version: 4 } });

    // The system stream too: the vocabulary is seeded once, and numbered on.
    const curator = await world().person('curator');
    await curator.ask('frame:add-entity-type', { tag: 'Restarted' });
    const system = world().stored('__system__');
    expect(system.filter((e) => e.type === 'frame:entity-type-added' && e.payload['entityType'] === 'Person')).toHaveLength(1);
    expect(system.filter((e) => e.type === 'frame:entity-type-added').at(-1)).toMatchObject({ payload: { entityType: 'Restarted' } });
  });

  it('rebuilds every view and projection from the log when the state directory is gone', async () => {
    const { id, annotationId } = await annotated(world(), 'rebuilt');
    const curator = await world().person('curator');
    await curator.ask('frame:add-tag-schema', { schema: { id: 'rebuilt', name: 'Rebuilt', description: 'Survives', domain: 'general', tags: [] } });
    await curator.emit('person:profile', { name: 'The Curator' });
    await curator.fact('person:profiled', (e) => e.payload['name'] === 'The Curator');
    const before = { view: world().view(id), types: world().projection('entitytypes.json'), schemas: world().projection('tagschemas.json'), people: world().projection('people.json'), entry: world().storageUriEntry('file://survives/rebuilt.md') };
    expect(before.entry).toEqual({ uri: 'file://survives/rebuilt.md', resourceId: id });

    await world().archivist.stop();
    rmSync(world().dirs.stateDir, { recursive: true, force: true });
    await world().restart();

    expect(world().view(id)).toEqual(before.view);
    expect(world().projection('entitytypes.json')).toEqual(before.types);
    expect(world().projection('tagschemas.json')).toEqual(before.schemas);
    expect(world().projection('people.json')).toEqual(before.people);
    expect(world().storageUriEntry('file://survives/rebuilt.md')).toEqual(before.entry);

    const reader = await world().person('reader');
    expect(await reader.ask('browse:annotation-requested', { resourceId: id, annotationId })).toMatchObject({ annotation: { id: annotationId } });
    // A rebuild publishes nothing: no event of a resource reaches a stream opened after it.
    expect(reader.facts().filter((e) => e.resourceId !== undefined)).toEqual([]);
  });

  it('rebuilds a view that is wrong, and reaps a view whose resource has no stream', async () => {
    const { id } = await annotated(world(), 'corrected');
    const good = readFileSync(world().viewPath(id), 'utf8');
    const orphanId = '0f'.repeat(16);
    const orphan = world().viewPath(orphanId);

    await world().archivist.stop();
    writeFileSync(world().viewPath(id), good.replace('"name": "corrected"', '"name": "tampered with"'));
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, good.replaceAll(id, orphanId));
    await world().restart();

    expect(world().view(id)!.resource.name).toBe('corrected');
    expect(existsSync(orphan)).toBe(false);
  });

  it('serves the views it finds, rebuilding and reaping nothing, when told to skip the rebuild', async () => {
    const { id } = await annotated(world(), 'skipped');
    const good = readFileSync(world().viewPath(id), 'utf8');
    const orphanId = '0e'.repeat(16);
    const orphan = world().viewPath(orphanId);

    await world().archivist.stop();
    writeFileSync(world().viewPath(id), good.replace('"name": "skipped"', '"name": "left as found"'));
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, good.replaceAll(id, orphanId));
    await world().restart((s) => ({ ...s, skipRebuild: true }));

    const reader = await world().person('reader');
    expect((await reader.ask('browse:resource-requested', { resourceId: id }))['resource']).toMatchObject({ name: 'left as found' });
    expect(existsSync(orphan)).toBe(true);

    await world().restart((s) => ({ ...s, skipRebuild: false }));
    expect(world().view(id)!.resource.name).toBe('skipped');
    expect(existsSync(orphan)).toBe(false);
  });

  it('reads a log as it finds it: blank lines skipped, a line that is not JSON skipped, an enveloped line unwrapped', async () => {
    const { id } = await annotated(world(), 'as found');
    const file = join(world().streamDir(id), 'events-000001.jsonl');
    const third = {
      event: { type: 'mark:archived', resourceId: id, userId: world().world.personDid('ada'), version: 1, payload: {}, id: '6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f', timestamp: '2026-02-02T02:02:02.002Z' },
      metadata: { sequenceNumber: 3 },
    };

    await world().archivist.stop();
    appendFileSync(file, `\nthis line is not JSON\n${JSON.stringify(third)}\n`);
    await world().restart();

    expect(world().view(id)).toMatchObject({ lastSequence: 3, resource: { archived: true } });
    const replay = await world().http('GET', `/events/${id}?fromSequence=1`, { route: '/events/{resourceId}' });
    const events = (replay.json as { events: Array<{ type: string; metadata: { sequenceNumber: number } }> }).events;
    expect(events.map((e) => [e.type, e.metadata.sequenceNumber])).toEqual([['yield:created', 1], ['mark:added', 2], ['mark:archived', 3]]);

    const editor = await world().person('editor');
    await editor.ask('mark:unarchive', { resourceId: id });
    expect(JSON.parse(world().streamLines(id).at(-1)!)).toMatchObject({ type: 'mark:unarchived', metadata: { sequenceNumber: 4 } });
  });

  it('keeps a clone token only as long as the process', async () => {
    const { id } = await annotated(world(), 'tokened');
    const cloner = await world().person('cloner');
    const { token } = (await cloner.ask('yield:clone-token-requested', { resourceId: id })) as { token: string };
    expect((await cloner.ask('yield:clone-resource-requested', { token }))['sourceResource']).toMatchObject({ '@id': id });

    await world().restart();
    expect(await (await world().person('cloner')).refused('yield:clone-resource-requested', { token })).toBe('Invalid or expired token');
  });
});
