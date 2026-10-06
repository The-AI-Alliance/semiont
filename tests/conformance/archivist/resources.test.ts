/**
 * Resources (ARCHIVIST.md § Resources, § The record on disk, § Facts, § The
 * HTTP surface): an upload stored and recorded, what the record then holds
 * and publishes, and the commands that change a resource.
 */
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { sha256, shardOf, unstamped, withArchivist } from '../harness/archivist-world';
import { eventually } from '../harness/net';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

withArchivist('a resource', (world) => {
  it('is stored, recorded and published by an upload', async () => {
    const ada = world().world.personDid('ada');
    const watcher = await world().sidecar('watcher');
    const content = '# Overview\n\nThe record of everything.\n';
    const uri = 'file://docs/overview.md';

    const id = await world().created(ada, { name: 'Overview', storageUri: uri, content, language: 'en', entityTypes: JSON.stringify(['Concept']) });

    // The id is the Archivist's to mint.
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // The bytes are in the working tree, where the storage URI says.
    expect(readFileSync(world().contentPath(uri), 'utf8')).toBe(content);

    // One line, in the stream filed by the shard of the id.
    expect(world().streamFiles(id)).toEqual(['events-000001.jsonl']);
    const [line] = world().streamLines(id);
    const event = JSON.parse(line!);
    expect(Object.keys(event)).toEqual(['type', 'resourceId', 'userId', 'version', 'payload', 'id', 'timestamp', 'metadata']);
    expect(line).toBe(JSON.stringify(event));
    expect(event).toMatchObject({ type: 'yield:created', resourceId: id, userId: ada, version: 1, metadata: { sequenceNumber: 1 } });
    expect(event.id).toMatch(UUID);
    expect(event.timestamp).toMatch(TIMESTAMP);
    expect(event.payload).toMatchObject({
      name: 'Overview',
      format: 'text/markdown',
      contentChecksum: sha256(content),
      contentByteSize: Buffer.byteLength(content),
      storageUri: uri,
      entityTypes: ['Concept'],
      language: 'en',
      isDraft: false,
      creator: { '@type': 'Person', '@id': ada },
      wasAttributedTo: [{ '@type': 'Person', '@id': ada }],
    });
    expect(event.payload).not.toHaveProperty('generator');
    expect(event).not.toHaveProperty('correlationId');

    // The view, filed by the same shard, is what the event adds up to.
    const view = world().view(id)!;
    expect(view.lastSequence).toBe(1);
    expect(view.annotations).toEqual({ resourceId: id, annotations: [], version: 1, updatedAt: event.timestamp });
    expect(view.resource).toMatchObject({
      '@id': id,
      name: 'Overview',
      archived: false,
      entityTypes: ['Concept'],
      dateCreated: event.timestamp,
      isDraft: false,
      representations: [{ mediaType: 'text/markdown', checksum: sha256(content), byteSize: Buffer.byteLength(content), rel: 'original', language: 'en', storageUri: uri }],
    });

    // The index answers which resource is at the URI.
    expect(world().storageUriEntry(uri)).toEqual({ uri, resourceId: id });
    expect(Object.keys(JSON.parse(readFileSync(world().storageUriPath(uri), 'utf8')))).toEqual(['uri', 'resourceId']);

    // The fact is the stored event, published once with no scope.
    const fact = await watcher.fact('yield:created', (e) => e.resourceId === id);
    expect(fact).toEqual(event);
    expect(watcher.facts('yield:created').filter((e) => e.resourceId === id)).toHaveLength(1);
  });

  it('publishes each event to its resource\'s scope too, with the id a stream resumes from', async () => {
    const ada = world().world.personDid('ada');
    const id = await world().created(ada, { name: 'Scoped', storageUri: 'file://docs/scoped.md', content: 'scoped\n' });
    const follower = await world().person('follower', { scopes: [id] });
    const answer = await follower.ask('mark:archive', { resourceId: id });
    expect(answer).toEqual({});

    const scoped = await follower.stream.next('the scoped fact', (m) => m.frame?.channel === 'mark:archived' && m.frame.scope === id);
    expect(scoped.id).toBe(`p-${id}-2`);
    expect(scoped.frame!.payload).toMatchObject({ type: 'mark:archived', resourceId: id, metadata: { sequenceNumber: 2 } });
    expect(scoped.frame!.correlationId).toBeUndefined();
    const unscoped = await follower.fact('mark:archived', (e) => e.resourceId === id);
    expect(unscoped).toEqual(unstamped(scoped.frame!.payload));
  });

  it('serves the content it stored, as the media type recorded', async () => {
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);
    const id = await world().created(world().world.personDid('ada'), { name: 'Pixels', storageUri: 'file://images/pixels.png', format: 'image/png', content });
    const reply = await world().http('GET', `/resources/${id}/content`, { route: '/resources/{id}/content' });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('image/png');
    expect(reply.bytes.equals(content)).toBe(true);
  });

  it('answers 404 for content and for a description of a resource it does not hold', async () => {
    const content = await world().http('GET', '/resources/0123456789abcdef0123456789abcdef/content', { route: '/resources/{id}/content' });
    expect(content.status).toBe(404);
    expect(content.json).toEqual({ error: 'Resource not found: 0123456789abcdef0123456789abcdef', code: 'resource' });
    const described = await world().http('GET', '/resources/0123456789abcdef0123456789abcdef/jsonld', { route: '/resources/{id}/jsonld' });
    expect(described.status).toBe(404);
    expect(described.json).toEqual({ error: 'Resource not found' });
  });

  it('describes a resource as JSON-LD: what browse answers', async () => {
    const reader = await world().person('reader');
    const id = await world().created(reader.did, { name: 'Described', storageUri: 'file://docs/described.md', content: 'described\n' });
    const reply = await world().http('GET', `/resources/${id}/jsonld`, { route: '/resources/{id}/jsonld' });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('application/ld+json; charset=utf-8');
    const browsed = await reader.ask('browse:resource-requested', { resourceId: id });
    expect(reply.json).toEqual(browsed);
    expect(browsed).toMatchObject({ resource: { '@id': id, name: 'Described' }, annotations: [], entityReferences: [] });
  });

  it('serves a stream\'s stored events from a sequence on', async () => {
    const id = await world().created(world().world.personDid('ada'), { name: 'Replayed', storageUri: 'file://docs/replayed.md', content: 'replayed\n' });
    const editor = await world().person('editor');
    await editor.ask('mark:archive', { resourceId: id });
    await editor.ask('mark:unarchive', { resourceId: id });

    const all = await world().http('GET', `/events/${id}?fromSequence=1`, { route: '/events/{resourceId}' });
    expect(all.status).toBe(200);
    expect((all.json as { events: unknown[] }).events).toEqual(world().stored(id));
    expect(world().stored(id).map((e) => [e.type, e.metadata.sequenceNumber])).toEqual([['yield:created', 1], ['mark:archived', 2], ['mark:unarchived', 3]]);

    const tail = await world().http('GET', `/events/${id}?fromSequence=3`, { route: '/events/{resourceId}' });
    expect((tail.json as { events: Array<{ type: string }> }).events.map((e) => e.type)).toEqual(['mark:unarchived']);

    const none = await world().http('GET', '/events/0123456789abcdef0123456789abcdef?fromSequence=1', { route: '/events/{resourceId}' });
    expect(none.json).toEqual({ events: [] });

    for (const query of ['', '?fromSequence=0', '?fromSequence=-1', '?fromSequence=abc', '?fromSequence=1.5']) {
      const refused = await world().http('GET', `/events/${id}${query}`, { route: '/events/{resourceId}' });
      expect(refused.status, query).toBe(400);
      expect(refused.json, query).toEqual({ error: 'resourceId path segment and integer fromSequence >= 1 are required' });
    }
  });

  it('admits only a service to its HTTP surface', async () => {
    const id = await world().created(world().world.personDid('ada'), { name: 'Guarded', storageUri: 'file://docs/guarded.md', content: 'guarded\n' });
    const person = await world().world.person('ada');
    const routes: Array<[string, string, string]> = [
      ['GET', `/events/${id}?fromSequence=1`, '/events/{resourceId}'],
      ['GET', `/resources/${id}/content`, '/resources/{id}/content'],
      ['GET', `/resources/${id}/jsonld`, '/resources/{id}/jsonld'],
      ['POST', '/resources', '/resources'],
    ];
    for (const [method, path, route] of routes) {
      const anonymous = await world().http(method, path, { anonymous: true, route });
      expect(anonymous.status, `${method} ${path} with no token`).toBe(401);
      expect(anonymous.json).toEqual({ error: 'unauthorized' });
      expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');

      for (const [who, token] of [['a person', person], ['a token that is not one', 'not-a-token'], ['a service account without the role', await world().serviceToken([])]] as const) {
        const refused = await world().http(method, path, { token, route });
        expect(refused.status, `${method} ${path} as ${who}`).toBe(401);
        expect(refused.json).toEqual({ error: 'unauthorized' });
        expect(refused.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      }
    }
  });

  it('refuses an upload it cannot record, saying why', async () => {
    const ada = world().world.personDid('ada');
    const form = (fields: Record<string, string>, file = true) => {
      const body = new FormData();
      for (const [name, value] of Object.entries(fields)) body.set(name, value);
      if (file) body.set('file', new Blob(['bytes']), 'upload');
      return body;
    };
    const good = { name: 'Refused', storageUri: 'file://docs/refused.md', format: 'text/markdown' };
    const post = (body: BodyInit, headers: Record<string, string> = { 'Semiont-Principal': ada }) => world().http('POST', '/resources', { body, headers, route: '/resources' });

    const unattributed = await post(form(good), {});
    expect(unattributed.status).toBe(400);
    expect(unattributed.json).toEqual({ error: 'Semiont-Principal is required: the record attributes every resource to someone' });

    const notMultipart = await world().http('POST', '/resources', { json: good, headers: { 'Semiont-Principal': ada }, route: '/resources' });
    expect(notMultipart.status).toBe(400);
    expect(notMultipart.json).toEqual({ error: 'The body is not multipart/form-data' });

    for (const missing of ['name', 'format', 'storageUri'] as const) {
      const { [missing]: _dropped, ...rest } = good;
      const reply = await post(form(rest));
      expect(reply.status, `without ${missing}`).toBe(400);
      expect((reply.json as { error: string }).error, `without ${missing}`).toContain(missing);
    }
    const noFile = await post(form(good, false));
    expect(noFile.status).toBe(400);
    expect((noFile.json as { error: string }).error).toContain('file');

    const unknownMedia = await post(form({ ...good, format: 'application/x-not-a-thing' }));
    expect(unknownMedia.status).toBe(400);
    expect(unknownMedia.json).toEqual({ error: 'Unsupported media type: application/x-not-a-thing' });

    for (const [field, value] of [['entityTypes', 'Concept'], ['entityTypes', '{"a":1}'], ['generator', 'not json'], ['generator', '{"name":"x"}']] as const) {
      const reply = await post(form({ ...good, [field]: value }));
      expect(reply.status, `${field}=${value}`).toBe(400);
      expect((reply.json as { error: string }).error, `${field}=${value}`).toContain(field);
    }

    // Nothing was recorded for any of them.
    expect(world().storageUriEntry(good.storageUri)).toBeUndefined();
  });

  it('records the media type as given, parameters included', async () => {
    const id = await world().created(world().world.personDid('ada'), { name: 'Charset', storageUri: 'file://docs/charset.txt', format: 'text/plain; charset=utf-8', content: 'plain\n' });
    expect(world().stored(id)[0]!.payload['format']).toBe('text/plain; charset=utf-8');
  });

  it('records new content for a resource: its checksum and size, and when', async () => {
    const editor = await world().person('editor');
    const uri = 'file://docs/updated.md';
    const id = await world().created(editor.did, { name: 'Updated', storageUri: uri, content: 'first\n' });
    const next = 'second, and longer\n';
    world().write(uri, next);

    const response = await editor.ask('yield:update', { resourceId: id, storageUri: uri, contentChecksum: sha256(next), byteSize: Buffer.byteLength(next) });
    expect(response).toEqual({ resourceId: id });

    const [, updated] = world().stored(id);
    expect(updated).toMatchObject({ type: 'yield:updated', userId: editor.did, payload: { contentChecksum: sha256(next), contentByteSize: Buffer.byteLength(next) }, metadata: { sequenceNumber: 2 } });
    const view = world().view(id)!;
    expect(view.resource.representations).toMatchObject([{ checksum: sha256(next), byteSize: Buffer.byteLength(next), storageUri: uri }]);
    expect(view.resource.dateModified).toBe(updated!.timestamp);
    expect(view.lastSequence).toBe(2);
  });

  it('refuses content that is not the checksum the command states, and records nothing', async () => {
    const editor = await world().person('editor');
    const uri = 'file://docs/mismatch.md';
    const id = await world().created(editor.did, { name: 'Mismatch', storageUri: uri, content: 'as stored\n' });
    world().write(uri, 'changed on disk\n');

    const message = await editor.refused('yield:update', { resourceId: id, storageUri: uri, contentChecksum: sha256('something else'), byteSize: 1 });
    expect(message).toMatch(new RegExp(`^Checksum mismatch for ${uri}: expected ${sha256('something else').slice(0, 8)}\\.\\.\\. but got ${sha256('changed on disk\n').slice(0, 8)}\\.\\.\\.`));
    expect(world().stored(id)).toHaveLength(1);

    const notAFile = await editor.refused('yield:update', { resourceId: id, storageUri: 'docs/mismatch.md', contentChecksum: sha256('x'), byteSize: 1 });
    expect(notAFile).toBe('Invalid storage URI (must start with file://): docs/mismatch.md');
  });

  it('records content already in the working tree, on yield:create', async () => {
    const author = await world().person('author');
    const uri = 'file://notes/already-here.md';
    const content = 'written by hand\n';
    world().write(uri, content);

    const { resourceId: id } = (await author.ask('yield:create', { name: 'Already here', storageUri: uri, contentChecksum: sha256(content), byteSize: Buffer.byteLength(content), format: 'text/markdown' })) as { resourceId: string };
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(world().stored(id)[0]).toMatchObject({ type: 'yield:created', userId: author.did, payload: { name: 'Already here', storageUri: uri, entityTypes: [], isDraft: false } });
    expect(world().stored(id)[0]!.payload).not.toHaveProperty('language');
    expect(world().storageUriEntry(uri)).toEqual({ uri, resourceId: id });
  });

  it('archives and unarchives, removing the file only when told to', async () => {
    const owner = await world().person('owner');
    const uri = 'file://docs/archived.md';
    const id = await world().created(owner.did, { name: 'Archived', storageUri: uri, content: 'to be archived\n' });

    expect(await owner.ask('mark:archive', { resourceId: id, storageUri: uri, keepFile: true })).toEqual({});
    expect(existsSync(world().contentPath(uri))).toBe(true);
    expect(world().view(id)!.resource.archived).toBe(true);
    expect(world().stored(id)[1]).toMatchObject({ type: 'mark:archived', payload: {} });
    // An archived resource is still found by its URI.
    expect(world().storageUriEntry(uri)).toEqual({ uri, resourceId: id });

    expect(await owner.ask('mark:unarchive', { resourceId: id, storageUri: uri })).toEqual({});
    expect(world().view(id)!.resource.archived).toBe(false);

    expect(await owner.ask('mark:archive', { resourceId: id, storageUri: uri })).toEqual({});
    expect(existsSync(world().contentPath(uri))).toBe(false);
    expect(await owner.refused('mark:unarchive', { resourceId: id, storageUri: uri })).toBe(`Cannot unarchive: file not found at ${uri}`);
    expect(world().stored(id).map((e) => e.type)).toEqual(['yield:created', 'mark:archived', 'mark:unarchived', 'mark:archived']);
  });

  it('changes a resource\'s entity types, to types the vocabulary has', async () => {
    const curator = await world().person('curator');
    const id = await world().created(curator.did, { name: 'Typed', storageUri: 'file://docs/typed.md', content: 'typed\n', entityTypes: JSON.stringify(['Concept', 'Event']) });

    expect(await curator.ask('mark:update-entity-types', { resourceId: id, currentEntityTypes: ['Concept', 'Event'], updatedEntityTypes: ['Event', 'Person', 'Location'] })).toEqual({});
    expect(world().stored(id).slice(1).map((e) => [e.type, e.payload['entityType']])).toEqual([
      ['mark:entity-tag-added', 'Person'],
      ['mark:entity-tag-added', 'Location'],
      ['mark:entity-tag-removed', 'Concept'],
    ]);
    expect(world().view(id)!.resource.entityTypes).toEqual(['Event', 'Person', 'Location']);

    const message = await curator.refused('mark:update-entity-types', { resourceId: id, currentEntityTypes: ['Event'], updatedEntityTypes: ['Event', 'Unheard', 'Of'] });
    expect(message).toBe('Entity type not registered: Unheard, Of');
    expect(world().stored(id)).toHaveLength(4);
  });

  it('files every stream, view and index entry where the shard table says', async () => {
    const id = await world().created(world().world.personDid('ada'), { name: 'Filed', storageUri: 'file://docs/résumé 📚.md', content: 'filed\n' });
    expect(world().streamDir(id)).toContain(`/.semiont/events/${shardOf(id)}/${id}`);
    expect(existsSync(world().viewPath(id))).toBe(true);
    await eventually('the index entry', 5_000, () => world().storageUriEntry('file://docs/résumé 📚.md'));
  });
});

withArchivist('the facts', (world) => {
  it('are published in the order their events were appended, to each scope and to none', async () => {
    const owner = await world().person('owner');
    const id = await world().created(owner.did, { name: 'Ordered', storageUri: 'file://docs/ordered.md', content: 'ordered\n' });
    const follower = await world().person('follower', { scopes: [id] });

    // Twenty events of one stream, each sent as the last is answered.
    for (let i = 0; i < 10; i++) {
      await owner.ask('mark:archive', { resourceId: id });
      await owner.ask('mark:unarchive', { resourceId: id });
    }
    await follower.stream.next('the last scoped fact', (m) => m.frame?.scope === id && m.id === `p-${id}-21`);
    await eventually('the last unscoped fact', 10_000, () => follower.facts().find((e) => e.resourceId === id && e.metadata.sequenceNumber === 21));

    const expected = Array.from({ length: 20 }, (_, i) => i + 2);
    const scoped = follower.stream.frames().filter((f) => f.scope === id).map((f) => (f.payload['metadata'] as { sequenceNumber: number }).sequenceNumber);
    expect(scoped).toEqual(expected);
    expect(follower.facts().filter((e) => e.resourceId === id).map((e) => e.metadata.sequenceNumber)).toEqual(expected);
    expect(world().stored(id).map((e) => e.metadata.sequenceNumber)).toEqual([1, ...expected]);
  });
});
