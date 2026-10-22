/**
 * The record read by position (ARCHIVIST.md § The event log, § The HTTP
 * surface): a stream's events from a sequence number on, a page at a time,
 * each answer with the sequence number of the stream's last event;
 * `__system__` read as a resource's stream is; and every stream listed with
 * where it stands.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { type StoredEvent, withArchivist } from '../harness/archivist-world';
import { archivistSpec } from '../harness/spec';

/** The most events one answer holds, as the Archivist's API states it. */
const PAGE = archivistSpec().limits('get', '/events/{resourceId}')['maxEvents']!;
/** The most events a file of a stream holds (ARCHIVIST.md § The event log). */
const PER_FILE = 10_000;

interface Page {
  events: StoredEvent[];
  lastSequence: number;
}

const sequenceOf = (event: StoredEvent) => event.metadata.sequenceNumber;
const from = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

withArchivist('the record read by position', (world) => {
  const page = async (stream: string, fromSequence: number): Promise<Page> => {
    const reply = await world().http('GET', `/events/${encodeURIComponent(stream)}?fromSequence=${fromSequence}`, { route: '/events/{resourceId}' });
    expect(reply.status, reply.text).toBe(200);
    return reply.json as Page;
  };

  /** Every event of a stream from `fromSequence` on: each page read from the sequence after the last one, until the stream's last. */
  const readOn = async (stream: string, fromSequence: number): Promise<StoredEvent[]> => {
    const read: StoredEvent[] = [];
    let next = fromSequence;
    for (;;) {
      const answered = await page(stream, next);
      expect(answered.events.length).toBeLessThanOrEqual(PAGE);
      read.push(...answered.events);
      const last = answered.events.at(-1);
      if (last === undefined || sequenceOf(last) >= answered.lastSequence) return read;
      next = sequenceOf(last) + 1;
    }
  };

  /** The sequence number of a stream's last event, as its files hold it: 0 for one with none. */
  const lastOnDisk = (stream: string) => {
    const stored = world().stored(stream);
    return stored.length === 0 ? 0 : sequenceOf(stored[stored.length - 1]!);
  };

  it('serves a stream\'s stored events from a sequence on, with the sequence number of its last event', async () => {
    const id = await world().created(world().world.personDid('ada'), { name: 'Replayed', storageUri: 'file://docs/replayed.md', content: 'replayed\n' });
    const editor = await world().person('editor');
    await editor.ask('mark:archive', { resourceId: id });
    await editor.ask('mark:unarchive', { resourceId: id });
    expect(world().stored(id).map((e) => [e.type, sequenceOf(e)])).toEqual([['yield:created', 1], ['mark:archived', 2], ['mark:unarchived', 3]]);

    expect(await page(id, 1)).toEqual({ events: world().stored(id), lastSequence: 3 });
    expect(await page(id, 3)).toEqual({ events: world().stored(id).slice(2), lastSequence: 3 });
    // Past the end, and a stream that is not there: no events, and where the stream stands.
    expect(await page(id, 4)).toEqual({ events: [], lastSequence: 3 });
    expect(await page('0123456789abcdef0123456789abcdef', 1)).toEqual({ events: [], lastSequence: 0 });

    for (const query of ['', '?fromSequence=0', '?fromSequence=-1', '?fromSequence=abc', '?fromSequence=1.5']) {
      const refused = await world().http('GET', `/events/${id}${query}`, { route: '/events/{resourceId}' });
      expect(refused.status, query).toBe(400);
      expect(refused.json, query).toEqual({ error: 'resourceId path segment and integer fromSequence >= 1 are required' });
    }
  });

  it('serves a long stream a page at a time, across the files it is kept in', async () => {
    // A stream longer than a file, written as the Archivist writes one: its first file full, the rest in the next.
    const id = randomUUID().replaceAll('-', '');
    const total = PER_FILE + 5;
    const user = world().world.personDid('ada');
    const line = (sequenceNumber: number) =>
      JSON.stringify({ type: 'mark:archived', resourceId: id, userId: user, version: 1, payload: {}, id: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z', metadata: { sequenceNumber } });
    const dir = world().streamDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events-000001.jsonl'), from(1, PER_FILE).map(line).join('\n') + '\n');
    writeFileSync(join(dir, 'events-000002.jsonl'), from(PER_FILE + 1, total).map(line).join('\n') + '\n');

    const first = await page(id, 1);
    expect(first.events.map(sequenceOf)).toEqual(from(1, PAGE));
    expect(first.lastSequence).toBe(total);
    // From the end of the first file into the second.
    expect((await page(id, PER_FILE - 1)).events.map(sequenceOf)).toEqual(from(PER_FILE - 1, total));
    // Every event, once, in order, as stored.
    expect(await readOn(id, 1)).toEqual(world().stored(id));
    expect(await page(id, total + 1)).toEqual({ events: [], lastSequence: total });
  });

  it('reads `__system__` as it reads a resource\'s stream', async () => {
    const curator = await world().person('curator');
    expect(await curator.ask('frame:add-entity-type', { tag: 'Positioned' })).toEqual({});
    const stored = world().stored('__system__');
    const last = lastOnDisk('__system__');
    expect(stored.at(-1)).toMatchObject({ type: 'frame:entity-type-added', payload: { entityType: 'Positioned' } });

    expect(await readOn('__system__', 1)).toEqual(stored);
    expect(await page('__system__', last)).toEqual({ events: [stored.at(-1)], lastSequence: last });
  });

  it('lists every stream, `__system__` among them, with the sequence number of its last event', async () => {
    const ada = world().world.personDid('ada');
    const once = await world().created(ada, { name: 'Once', storageUri: 'file://docs/once.md', content: 'once\n' });
    const twice = await world().created(ada, { name: 'Twice', storageUri: 'file://docs/twice.md', content: 'twice\n' });
    await (await world().person('editor')).ask('mark:archive', { resourceId: twice });

    const reply = await world().http('GET', '/events', { route: '/events' });
    expect(reply.status, reply.text).toBe(200);
    const streams = (reply.json as { streams: Array<{ resourceId: string; lastSequence: number }> }).streams;
    const listed = new Map(streams.map((stream) => [stream.resourceId, stream.lastSequence]));
    // Each stream once.
    expect(listed.size).toBe(streams.length);
    expect(listed.get(once)).toBe(1);
    expect(listed.get(twice)).toBe(2);
    expect(listed.get('__system__')).toBe(lastOnDisk('__system__'));

    // Every stream the log holds on disk, and no other, each where its files say it stands.
    const events = dirname(world().streamDir('__system__'));
    const onDisk = [
      '__system__',
      ...readdirSync(events)
        .filter((ab) => ab !== '__system__')
        .flatMap((ab) => readdirSync(join(events, ab)).flatMap((cd) => readdirSync(join(events, ab, cd)))),
    ];
    expect([...listed.keys()].sort()).toEqual(onDisk.sort());
    for (const [stream, lastSequence] of listed) expect(lastSequence, stream).toBe(lastOnDisk(stream));
  });
});
