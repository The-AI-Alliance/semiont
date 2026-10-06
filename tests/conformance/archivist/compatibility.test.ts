/**
 * One tree, two implementations (ARCHIVIST.md § The record on disk): what one
 * Archivist writes, another reads, rebuilds byte for byte, and goes on from.
 * Each run judges one implementation and passes the tree to the other and
 * back.
 */
import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { highlight, sha256, withArchivist, type ArchivistWorld } from '../harness/archivist-world';
import { eventually } from '../harness/net';

const TEXT = 'Two implementations keep one record: résumé, naïve, 📚.\n';

/** A knowledge base with a little of everything the record holds. */
async function populate(world: ArchivistWorld): Promise<{ id: string; clone: string; annotationId: string }> {
  const ada = await world.person('ada');
  const id = await world.created(ada.did, { name: 'Shared', storageUri: 'file://shared/résumé 📚.md', content: TEXT, language: 'en', entityTypes: JSON.stringify(['Concept']) });
  const { annotationId } = (await ada.ask('mark:create-request', { resourceId: id, request: { ...highlight(id, 'record', 29), motivation: 'linking' } })) as { annotationId: string };
  await ada.ask('bind:update-body', { resourceId: id, annotationId, operations: [{ op: 'add', item: { type: 'TextualBody', value: 'Concept', purpose: 'tagging' } }] });
  await ada.ask('mark:update-entity-types', { resourceId: id, currentEntityTypes: ['Concept'], updatedEntityTypes: ['Concept', 'Event'] });
  await ada.ask('frame:add-entity-type', { tag: 'Élan' });
  await ada.ask('frame:add-tag-schema', { schema: { id: 'shared', name: 'Shared', description: 'Kept by both', domain: 'general', tags: [{ name: 'Claim', description: 'What is asserted', examples: ['It is so'] }] } });
  const next = `${TEXT}More.\n`;
  world.write('file://shared/résumé 📚.md', next);
  await ada.ask('yield:update', { resourceId: id, storageUri: 'file://shared/résumé 📚.md', contentChecksum: sha256(next), byteSize: Buffer.byteLength(next) });
  const { token } = (await ada.ask('yield:clone-token-requested', { resourceId: id })) as { token: string };
  const clone = await world.created(ada.did, { name: 'A copy', storageUri: 'file://shared/copy.md', content: 'copy\n', cloneToken: token });
  await ada.ask('mark:archive', { resourceId: clone });
  const namer = await world.sidecar('namer');
  await namer.emit('person:profile', { name: 'The Namer' });
  await eventually('the profile', 10_000, () => world.stored('__system__').find((e) => e.type === 'person:profiled' && e.payload['name'] === 'The Namer'));
  // The views are written before an append is answered; the last one-way command has now landed too.
  await eventually('the people projection', 10_000, () => (world.projection<{ people: Record<string, unknown> }>('people.json')?.people[namer.did] ? true : undefined));
  return { id, clone, annotationId };
}

withArchivist('a tree written by this Archivist', (world) => {
  it('is rebuilt by the other, byte for byte', async () => {
    const { id } = await populate(world());
    const written = world().stateFiles();
    expect([...written.keys()].some((name) => name.startsWith('resources/'))).toBe(true);
    expect(written.has('projections/__system__/people.json')).toBe(true);

    await world().archivist.stop();
    rmSync(world().dirs.stateDir, { recursive: true, force: true });
    await world().restart((s) => s, true);

    const rebuilt = world().stateFiles();
    expect([...rebuilt.keys()].sort()).toEqual([...written.keys()].sort());
    for (const [name, bytes] of written) expect(rebuilt.get(name), name).toBe(bytes);
    expect(world().view(id)!.lastSequence).toBe(5);
  });

  it('is gone on from by the other, and then by this one again', async () => {
    const { id, annotationId } = await populate(world());

    await world().restart((s) => s, true);
    const peer = await world().person('grace');
    await peer.ask('mark:archive', { resourceId: id });
    const second = ((await peer.ask('mark:create-request', { resourceId: id, request: highlight(id, 'Two', 0) })) as { annotationId: string }).annotationId;
    await peer.ask('frame:add-entity-type', { tag: 'Peer' });

    await world().restart();
    const back = await world().person('grace');
    await back.ask('mark:unarchive', { resourceId: id });

    const events = world().stored(id);
    expect(events.map((e) => e.metadata.sequenceNumber)).toEqual(events.map((_, i) => i + 1));
    expect(events.slice(-3).map((e) => e.type)).toEqual(['mark:archived', 'mark:added', 'mark:unarchived']);
    for (const line of world().streamLines(id)) expect(line).toBe(JSON.stringify(JSON.parse(line)));

    const view = world().view(id)!;
    expect(view.lastSequence).toBe(events.length);
    expect(view.resource.archived).toBe(false);
    expect(view.annotations.annotations.map((a) => a.id)).toEqual([annotationId, second]);
    expect(world().projection<{ entityTypes: string[] }>('entitytypes.json')!.entityTypes).toEqual(expect.arrayContaining(['Élan', 'Peer']));

    // What this one now holds is what the other would build from the same log.
    const held = world().stateFiles();
    await world().archivist.stop();
    rmSync(world().dirs.stateDir, { recursive: true, force: true });
    await world().restart((s) => s, true);
    const rebuilt = world().stateFiles();
    for (const [name, bytes] of held) expect(rebuilt.get(name), name).toBe(bytes);
  });
});
