/**
 * Browse (ARCHIVIST.md § Browse): the reads the Archivist answers from its
 * views, its log, the working tree, the roster and the anchored-text store.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { anchoredEntry, sha256, withArchivist, type Roster } from '../harness/archivist-world';

// Written out of the order the roster's schema states its roles in: the
// answer is in the schema's.
const ROSTER: Roster = {
  workers: {
    yield: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    mark: {
      tagging: { provider: 'ollama', model: 'gemma2:27b' },
      linking: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      highlighting: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    },
  },
  actors: { gatherer: { provider: 'ollama', model: 'llama3' }, matcher: { provider: 'anthropic', model: 'claude-haiku-4-5' } },
};

withArchivist('browsing', (world) => {
  it('describes the knowledge base: its name, its domain and its branch', async () => {
    const reader = await world().person('reader');
    const kb = await reader.ask('browse:kb-requested', {});
    expect(kb).toMatchObject({ name: world().world.kb.name, domain: world().world.kb.domain });
    // A checkout with no commit is on no branch yet.
    expect(Object.keys(kb).filter((k) => !['name', 'domain', 'gitBranch'].includes(k))).toEqual([]);
  });

  it('answers the vocabulary: the default entity types, seeded as the knowledge base itself, and what is added', async () => {
    const curator = await world().person('curator');
    const defaults = ['Author', 'Concept', 'Date', 'Event', 'Location', 'Organization', 'Person', 'Product', 'Technology'];
    expect(((await curator.ask('browse:entity-types-requested', {}))['entityTypes'] as string[]).slice().sort()).toEqual(defaults);
    const seeded = world().stored('__system__').filter((e) => e.type === 'frame:entity-type-added');
    expect(seeded.map((e) => e.payload['entityType'])).toEqual(['Person', 'Organization', 'Location', 'Event', 'Concept', 'Product', 'Technology', 'Date', 'Author']);
    expect(new Set(seeded.map((e) => e.userId))).toEqual(new Set([world().world.kb.did]));
    expect(seeded.every((e) => !('resourceId' in e))).toBe(true);
    expect(seeded.map((e) => e.metadata.sequenceNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(await curator.ask('frame:add-entity-type', { tag: 'Zeitgeist' })).toEqual({});
    expect(world().stored('__system__').filter((e) => e.type === 'frame:entity-type-added').at(-1)).toMatchObject({ userId: curator.did, payload: { entityType: 'Zeitgeist' } });
    expect((await curator.ask('browse:entity-types-requested', {}))['entityTypes']).toContain('Zeitgeist');
    expect(world().projection<{ entityTypes: string[] }>('entitytypes.json')!.entityTypes.slice().sort()).toEqual([...defaults, 'Zeitgeist']);

    // A system fact is published once, with no scope.
    const fact = await curator.fact('frame:entity-type-added', (e) => e.payload['entityType'] === 'Zeitgeist');
    expect(fact).not.toHaveProperty('resourceId');
  });

  it('answers the tag schemas, by id, the latest under each', async () => {
    const curator = await world().person('curator');
    const schema = (id: string, name: string) => ({ id, name, description: `${name} analysis`, domain: 'general', tags: [{ name: 'Claim', description: 'What is asserted', examples: ['The sky is blue'] }] });
    expect((await curator.ask('browse:tag-schemas-requested', {}))['tagSchemas']).toEqual([]);

    expect(await curator.ask('frame:add-tag-schema', { schema: schema('toulmin', 'Toulmin') })).toEqual({});
    await curator.ask('frame:add-tag-schema', { schema: schema('irac', 'IRAC') });
    await curator.ask('frame:add-tag-schema', { schema: schema('toulmin', 'Toulmin, revised') });

    const answered = (await curator.ask('browse:tag-schemas-requested', {}))['tagSchemas'] as Array<{ id: string; name: string }>;
    expect(answered.map((s) => [s.id, s.name])).toEqual([['irac', 'IRAC'], ['toulmin', 'Toulmin, revised']]);
    expect(world().projection('tagschemas.json')).toEqual({ tagSchemas: answered });
    expect(world().stored('__system__').filter((e) => e.type === 'frame:tag-schema-added')).toHaveLength(3);
  });

  it('lists resources newest first, filtered and paged, with the whole count', async () => {
    const ada = world().world.personDid('ada');
    const reader = await world().person('reader');
    const ids: string[] = [];
    for (const [n, types] of [['one', ['Concept']], ['two', ['Event']], ['three', ['Concept', 'Event']]] as const) {
      ids.push(await world().created(ada, { name: `Listed ${n}`, storageUri: `file://listed/${n}.md`, content: `${n}\n`, entityTypes: JSON.stringify(types) }));
      await new Promise((r) => setTimeout(r, 5));
    }
    await reader.ask('mark:archive', { resourceId: ids[1]! });

    const mine = (response: Record<string, unknown>) => (response['resources'] as Array<{ '@id': string }>).map((r) => r['@id']).filter((id) => ids.includes(id));
    const all = await reader.ask('browse:resources-requested', {});
    expect(mine(all)).toEqual([ids[2], ids[1], ids[0]]);
    expect(all).toMatchObject({ offset: 0, limit: 50 });
    expect(all['total']).toBe((all['resources'] as unknown[]).length);

    expect(mine(await reader.ask('browse:resources-requested', { archived: false }))).toEqual([ids[2], ids[0]]);
    expect(mine(await reader.ask('browse:resources-requested', { archived: true }))).toEqual([ids[1]]);
    expect(mine(await reader.ask('browse:resources-requested', { entityType: 'Event' }))).toEqual([ids[2], ids[1]]);

    const page = await reader.ask('browse:resources-requested', { entityType: 'Concept', offset: 1, limit: 1 });
    expect(page).toMatchObject({ total: 2, offset: 1, limit: 1 });
    expect(mine(page)).toEqual([ids[0]]);
  });

  it('answers a resource\'s events, each with its sender as an agent, filtered and limited', async () => {
    const reader = await world().person('reader');
    const editor = await world().person('editor');
    const id = await world().created(reader.did, { name: 'Eventful', storageUri: 'file://listed/eventful.md', content: 'eventful\n' });
    await editor.ask('mark:archive', { resourceId: id });
    await reader.ask('mark:unarchive', { resourceId: id });

    const all = await reader.ask('browse:events-requested', { resourceId: id });
    const events = all['events'] as Array<{ type: string; agent: Record<string, unknown>; metadata: { sequenceNumber: number } }>;
    expect(events.map((e) => [e.type, e.metadata.sequenceNumber])).toEqual([['yield:created', 1], ['mark:archived', 2], ['mark:unarchived', 3]]);
    expect(events.map((e) => e.agent['@id'])).toEqual([reader.did, editor.did, reader.did]);
    expect(all).toMatchObject({ total: 3, resourceId: id });

    expect(((await reader.ask('browse:events-requested', { resourceId: id, type: 'mark:archived' }))['events'] as unknown[])).toHaveLength(1);
    expect(((await reader.ask('browse:events-requested', { resourceId: id, userId: reader.did }))['events'] as Array<{ type: string }>).map((e) => e.type)).toEqual(['yield:created', 'mark:unarchived']);
    expect(((await reader.ask('browse:events-requested', { resourceId: id, limit: 2 }))['events'] as Array<{ type: string }>).map((e) => e.type)).toEqual(['yield:created', 'mark:archived']);
    expect((await reader.ask('browse:events-requested', { resourceId: 'a'.repeat(32) }))['events']).toEqual([]);
  });

  it('answers not-found, by code, for a resource it has no events of', async () => {
    const reader = await world().person('reader');
    const answer = await reader.request('browse:resource-requested', { resourceId: 'b'.repeat(32) });
    expect(answer.ok).toBe(false);
    expect(answer.payload).toEqual({ code: 'not-found', message: 'Resource not found' });
  });

  it('names the people a reply mentions by their profile', async () => {
    const lovelace = await world().person('lovelace');
    const reader = await world().person('reader');
    const id = await world().created(lovelace.did, { name: 'Named', storageUri: 'file://listed/named.md', content: 'named\n' });

    // The gateway profiles a person, from their token, when they first write.
    await lovelace.ask('mark:update-entity-types', { resourceId: id, currentEntityTypes: [], updatedEntityTypes: ['Person'] });
    const profiled = await reader.fact('person:profiled', (e) => e.userId === lovelace.did);
    expect(profiled).not.toHaveProperty('resourceId');
    const name = profiled.payload['name'] as string;
    expect(world().projection<{ people: Record<string, { name: string; since: string }> }>('people.json')!.people[lovelace.did]).toEqual({ name, since: profiled.timestamp });

    const described = await reader.ask('browse:resource-requested', { resourceId: id });
    expect((described['resource'] as { wasAttributedTo: unknown[] }).wasAttributedTo).toEqual([{ '@type': 'Person', '@id': lovelace.did, name }]);
    const events = (await reader.ask('browse:events-requested', { resourceId: id }))['events'] as Array<{ agent: unknown }>;
    expect(events[0]!.agent).toEqual({ '@type': 'Person', '@id': lovelace.did, name });
    // The log holds the event as recorded: no name in it.
    expect(world().stored(id)[0]!.payload['wasAttributedTo']).toEqual([{ '@type': 'Person', '@id': lovelace.did }]);
  });

  it('records a profile when the name is new, and not when it is the name last recorded', async () => {
    const namer = await world().sidecar('namer');
    const mine = () => world().stored('__system__').filter((e) => e.type === 'person:profiled' && e.userId === namer.did).map((e) => e.payload['name']);

    await namer.emit('person:profile', { name: 'First' });
    await namer.fact('person:profiled', (e) => e.userId === namer.did && e.payload['name'] === 'First');
    await namer.emit('person:profile', { name: 'First' });
    await namer.emit('person:profile', { name: 'Second' });
    const second = await namer.fact('person:profiled', (e) => e.userId === namer.did && e.payload['name'] === 'Second');

    expect(mine()).toEqual(['First', 'Second']);
    expect(world().projection<{ people: Record<string, { name: string; since: string }> }>('people.json')!.people[namer.did]).toEqual({ name: 'Second', since: second.timestamp });
  });

  it('lists a directory of the working tree, and nothing outside it', async () => {
    const reader = await world().person('reader');
    mkdirSync(join(world().dirs.root, 'tree', 'inner'), { recursive: true });
    writeFileSync(join(world().dirs.root, 'tree', 'b.md'), 'bb');
    writeFileSync(join(world().dirs.root, 'tree', 'a.md'), 'a');
    writeFileSync(join(world().dirs.root, 'tree', '.hidden'), 'h');

    const listing = await reader.ask('browse:directory-requested', { path: 'tree' });
    expect(listing['path']).toBe('tree');
    const entries = listing['entries'] as Array<{ type: string; name: string; path: string; size?: number }>;
    expect(entries.map((e) => [e.type, e.name, e.path])).toEqual([['file', 'a.md', 'tree/a.md'], ['file', 'b.md', 'tree/b.md'], ['dir', 'inner', 'tree/inner']]);
    expect(entries.find((e) => e.name === 'b.md')!.size).toBe(2);

    const root = (await reader.ask('browse:directory-requested', { path: '.' }))['entries'] as Array<{ name: string }>;
    expect(root.map((e) => e.name)).not.toContain('.semiont');
    expect(root.map((e) => e.name)).not.toContain('.git');

    for (const [path, message] of [['../outside', 'path escapes project root'], ['/etc', 'path escapes project root'], ['tree/missing', 'path not found']] as const) {
      const refused = await reader.request('browse:directory-requested', { path });
      expect(refused.ok, path).toBe(false);
      expect(refused.payload, path).toEqual({ path, message });
    }
  });

  it('answers anchored text from the store, under the stamp its writer states', async () => {
    const reader = await world().person('reader');
    const content = Buffer.from('%PDF-1.4 the suite never parses this\n');
    const id = await world().created(reader.did, { name: 'Scanned', storageUri: 'file://scans/scanned.pdf', format: 'application/pdf', content });
    const text = 'alpha beta gamma';
    await world().smelt(id, sha256(content), anchoredEntry(text));

    const answer = await reader.ask('browse:anchored-text-requested', { resourceId: id });
    expect(answer).toMatchObject({ kind: 'extracted', text, method: 'ocr' });
    expect(answer['items']).toEqual([
      { start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 },
      { start: 6, end: 10, page: 1, x: 72, y: 686, width: 24, height: 12 },
      { start: 11, end: 16, page: 1, x: 72, y: 672, width: 30, height: 12 },
    ]);

    // The entry stands; the writer moves on to another stamp; the entry is no longer taken.
    writeFileSync(join(world().dirs.anchoredTextDir, 'STAMP'), 'a-newer-smelter\n');
    const other = await world().created(reader.did, { name: 'Scanned again', storageUri: 'file://scans/again.pdf', format: 'application/pdf', content });
    await world().smelt(other, sha256(content), undefined, 'indexed');
    expect(await reader.ask('browse:anchored-text-requested', { resourceId: other })).toEqual({ kind: 'not-yet' });
  });

  it('answers a decline, no-map for content the Smelter skipped, and unknown for no resource', async () => {
    const reader = await world().person('reader');
    const locked = Buffer.from('%PDF-1.4 locked\n');
    const declined = await world().created(reader.did, { name: 'Locked', storageUri: 'file://scans/locked.pdf', format: 'application/pdf', content: locked });
    await world().smelt(declined, sha256(locked), { declined: 'encrypted' });
    expect(await reader.ask('browse:anchored-text-requested', { resourceId: declined })).toEqual({ kind: 'declined', declined: 'encrypted' });

    const plain = Buffer.from('%PDF-1.4 skipped\n');
    const skipped = await world().created(reader.did, { name: 'Skipped', storageUri: 'file://scans/skipped.pdf', format: 'application/pdf', content: plain });
    await world().smelt(skipped, sha256(plain), undefined, 'skipped');
    expect(await reader.ask('browse:anchored-text-requested', { resourceId: skipped })).toEqual({ kind: 'no-map' });

    expect(await reader.ask('browse:anchored-text-requested', { resourceId: 'c'.repeat(32) })).toEqual({ kind: 'unknown' });
  });
});

withArchivist('the roster', (world) => {
  it('lists each agent once, in the order of its first role, with the jobs it serves as a claim would name them', async () => {
    const reader = await world().person('reader');
    const domain = world().world.kb.domain;
    const agent = (provider: string, model: string) => ({
      '@type': 'Software',
      '@id': `did:web:${domain}:agents:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`,
      name: `${provider} ${model}`,
      provider,
      model,
    });
    expect(await reader.ask('browse:agents-requested', {})).toEqual({
      agents: [
        { agent: agent('anthropic', 'claude-haiku-4-5'), serves: [{ jobType: 'mark', params: { motivation: 'highlighting' } }, { jobType: 'mark', params: { motivation: 'linking' } }] },
        { agent: agent('ollama', 'gemma2:27b'), serves: [{ jobType: 'mark', params: { motivation: 'tagging' } }] },
        { agent: agent('anthropic', 'claude-sonnet-4-5'), serves: [{ jobType: 'yield' }] },
        { agent: agent('ollama', 'llama3') },
      ],
    });
  });
}, { roster: ROSTER });

withArchivist('a knowledge base no one serves, that does not sync git', (world) => {
  it('lists no agents, and names no branch', async () => {
    const reader = await world().person('reader');
    expect(await reader.ask('browse:agents-requested', {})).toEqual({ agents: [] });
    expect(await reader.ask('browse:kb-requested', {})).toEqual({ name: world().world.kb.name, domain: world().world.kb.domain });
  });
}, { gitSync: false });
