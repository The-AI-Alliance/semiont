/**
 * Clone tokens (ARCHIVIST.md § Clone tokens): a token issued for a resource,
 * looked up, and spent on a copy.
 */
import { expect, it } from 'vitest';
import { sha256, withArchivist } from '../harness/archivist-world';
import { eventually } from '../harness/net';

withArchivist('a clone', (world) => {
  it('is made with a token, as a copy that names its source', async () => {
    const owner = await world().person('owner');
    const cloner = await world().person('cloner');
    const source = await world().created(owner.did, { name: 'Original', storageUri: 'file://clones/original.md', content: 'original\n', entityTypes: JSON.stringify(['Concept']) });

    const issued = await cloner.ask('yield:clone-token-requested', { resourceId: source });
    const token = issued['token'] as string;
    expect(token).toMatch(/^clone_[0-9a-f]{32}$/);
    expect(issued['resource']).toMatchObject({ '@id': source, name: 'Original' });
    const lifetime = Date.parse(issued['expiresAt'] as string) - Date.now();
    expect(lifetime).toBeGreaterThan(14 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000);

    // Looking a token up does not spend it.
    for (let i = 0; i < 2; i++) {
      expect(await cloner.ask('yield:clone-resource-requested', { token })).toMatchObject({ sourceResource: { '@id': source }, expiresAt: issued['expiresAt'] });
    }

    const copy = 'a copy, edited\n';
    const uri = 'file://clones/copy.md';
    world().write(uri, copy);
    const { resourceId: clone } = (await cloner.ask('yield:clone-create', { token, name: 'Copy', storageUri: uri, contentChecksum: sha256(copy), byteSize: Buffer.byteLength(copy), format: 'text/markdown' })) as { resourceId: string };

    expect(world().stored(clone)[0]).toMatchObject({
      type: 'yield:cloned',
      userId: cloner.did,
      payload: { name: 'Copy', storageUri: uri, contentChecksum: sha256(copy), parentResourceId: source, entityTypes: ['Concept'], creator: { '@id': cloner.did }, wasAttributedTo: [{ '@id': cloner.did }] },
      metadata: { sequenceNumber: 1 },
    });
    expect(world().view(clone)!.resource).toMatchObject({ name: 'Copy', sourceResourceId: source, entityTypes: ['Concept'], representations: [{ storageUri: uri, checksum: sha256(copy) }] });
    expect(world().storageUriEntry(uri)).toEqual({ uri, resourceId: clone });
    // The source is as it was.
    expect(world().view(source)!.resource.archived).toBe(false);

    // The token is spent.
    expect(await cloner.refused('yield:clone-resource-requested', { token })).toBe('Invalid or expired token');
  });

  it('is made by an upload that carries the token, archiving the source when asked', async () => {
    const owner = await world().person('owner');
    const source = await world().created(owner.did, { name: 'To replace', storageUri: 'file://clones/to-replace.md', content: 'old\n' });
    const { token } = (await owner.ask('yield:clone-token-requested', { resourceId: source })) as { token: string };

    const clone = await world().created(owner.did, { name: 'Replacement', storageUri: 'file://clones/replacement.md', content: 'new\n', cloneToken: token, archiveOriginal: 'true' });
    expect(world().stored(clone)[0]).toMatchObject({ type: 'yield:cloned', userId: owner.did, payload: { parentResourceId: source } });
    await eventually('the source to be archived', 5_000, () => (world().view(source)!.resource.archived ? true : undefined));
    expect(world().stored(source).at(-1)).toMatchObject({ type: 'mark:archived', userId: owner.did });
  });

  it('is refused without a token that names a resource whose content is there', async () => {
    const cloner = await world().person('cloner');
    expect(await cloner.refused('yield:clone-token-requested', { resourceId: 'd'.repeat(32) })).toBe('Resource not found');
    expect(await cloner.refused('yield:clone-resource-requested', { token: 'clone_' + '0'.repeat(32) })).toBe('Invalid or expired token');
    expect(await cloner.refused('yield:clone-create', { token: 'clone_' + '0'.repeat(32), name: 'x', storageUri: 'file://clones/x.md', contentChecksum: sha256('x'), byteSize: 1, format: 'text/markdown' })).toBe('Invalid or expired token');

    const gone = await world().created(cloner.did, { name: 'Gone', storageUri: 'file://clones/gone.md', content: 'gone\n' });
    await cloner.ask('mark:archive', { resourceId: gone, storageUri: 'file://clones/gone.md' });
    expect(await cloner.refused('yield:clone-token-requested', { resourceId: gone })).toBe('Resource content not found');
  });
});
