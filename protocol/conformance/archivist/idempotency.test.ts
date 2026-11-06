/**
 * An upload sent again (ARCHIVIST.md § The HTTP surface; the Archivist's API,
 * `POST /resources`): an upload carrying an `Idempotency-Key` its principal
 * has used makes nothing new. With the fields and bytes the key was first sent
 * with it is answered with the resource the key made, however it was sent
 * again; with others it is refused 422.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { withArchivist, type ArchivistWorld } from '../harness/archivist-world';
import type { Reply } from '../harness/http';

/** The id of every stream the log holds, as the Archivist lists them, sorted. */
async function streams(world: ArchivistWorld): Promise<string[]> {
  const listed = await world.http('GET', '/events', { route: '/events' });
  if (listed.status !== 200) throw new Error(`the streams were not listed: ${listed.status} ${listed.text}`);
  return (listed.json as { streams: Array<{ resourceId: string }> }).streams.map((stream) => stream.resourceId).sort();
}

/** The id of the resource an upload was answered with; the Archivist must have recorded it. */
function idOf(reply: Reply): string {
  if (reply.status !== 200) throw new Error(`the upload was not recorded: ${reply.status} ${reply.text}`);
  return (reply.json as { resourceId: string }).resourceId;
}

withArchivist('an upload sent again with its key', (world) => {
  it('is answered with the resource the first made, and nothing more is stored or recorded', async () => {
    const ada = world().world.personDid('ada');
    const key = randomUUID();
    const content = 'sent twice, recorded once\n';
    const fields = { name: 'Sent twice', storageUri: 'file://keyed/sent-twice.md', content };

    const id = idOf(await world().upload(ada, fields, [], key));
    const before = await streams(world());
    const again = await world().upload(ada, fields, [], key);

    expect(again.status).toBe(200);
    expect(again.json).toEqual({ resourceId: id });
    expect(await streams(world())).toEqual(before);
    expect(world().stored(id).map((event) => event.type)).toEqual(['yield:created']);
    expect(readFileSync(world().contentPath(fields.storageUri), 'utf8')).toBe(content);
    expect(world().storageUriEntry(fields.storageUri)).toEqual({ uri: fields.storageUri, resourceId: id });
  });

  it('twice at once makes one resource, and both are answered with it', async () => {
    const ada = world().world.personDid('ada');
    const key = randomUUID();
    const fields = { name: 'Sent at once', storageUri: 'file://keyed/sent-at-once.md', content: 'two at once, one resource\n' };
    const before = await streams(world());

    const [one, two] = await Promise.all([world().upload(ada, fields, [], key), world().upload(ada, fields, [], key)]);

    const id = idOf(one);
    expect(two.status).toBe(200);
    expect(two.json).toEqual({ resourceId: id });
    expect(await streams(world())).toEqual([...before, id].sort());
    expect(world().stored(id).map((event) => event.type)).toEqual(['yield:created']);
  });

  it('is refused 422 with other bytes or other fields, and nothing is stored or recorded', async () => {
    const ada = world().world.personDid('ada');
    const key = randomUUID();
    const content = 'the bytes the key was first sent with\n';
    const fields = { name: 'First of its key', storageUri: 'file://keyed/first-of-its-key.md', content };
    const elsewhere = 'file://keyed/elsewhere.md';
    const id = idOf(await world().upload(ada, fields, [], key));
    const before = await streams(world());

    const changed: Array<[string, typeof fields]> = [
      ['other bytes', { ...fields, content: 'other bytes under the same key\n' }],
      ['another name', { ...fields, name: 'Another name' }],
      ['another storage URI', { ...fields, storageUri: elsewhere }],
    ];
    for (const [why, other] of changed) {
      expect((await world().upload(ada, other, [], key)).status, why).toBe(422);
    }

    expect(await streams(world())).toEqual(before);
    expect(world().stored(id).map((event) => event.type)).toEqual(['yield:created']);
    expect(readFileSync(world().contentPath(fields.storageUri), 'utf8')).toBe(content);
    expect(existsSync(world().contentPath(elsewhere))).toBe(false);
    expect(world().storageUriEntry(elsewhere)).toBeUndefined();
  });

  it('from another principal is another key, and makes another resource', async () => {
    const ada = world().world.personDid('ada');
    const bea = world().world.personDid('bea');
    const key = randomUUID();
    const content = 'one key text, two principals\n';

    const adas = idOf(await world().upload(ada, { name: "Ada's", storageUri: 'file://keyed/adas.md', content }, [], key));
    const beas = idOf(await world().upload(bea, { name: "Bea's", storageUri: 'file://keyed/beas.md', content }, [], key));

    expect(beas).not.toBe(adas);
    expect(world().stored(adas)).toMatchObject([{ type: 'yield:created', userId: ada }]);
    expect(world().stored(beas)).toMatchObject([{ type: 'yield:created', userId: bea }]);
  });

  it('carrying a clone token is answered with the clone the first made, though the token is spent', async () => {
    const owner = await world().person('owner');
    const source = await world().created(owner.did, { name: 'Cloned once', storageUri: 'file://keyed/cloned-once.md', content: 'cloned once\n' });
    const { token } = (await owner.ask('yield:clone-token-requested', { resourceId: source })) as { token: string };
    const key = randomUUID();
    const fields = { name: 'The one clone', storageUri: 'file://keyed/the-one-clone.md', content: 'the clone\n', cloneToken: token };

    const clone = idOf(await world().upload(owner.did, fields, [], key));
    const before = await streams(world());
    const again = await world().upload(owner.did, fields, [], key);

    expect(again.status).toBe(200);
    expect(again.json).toEqual({ resourceId: clone });
    expect(await streams(world())).toEqual(before);
    expect(world().stored(clone)).toMatchObject([{ type: 'yield:cloned', userId: owner.did, payload: { parentResourceId: source } }]);
  });

  it('is answered with the resource the first made after the Archivist restarts on the same tree', async () => {
    const ada = world().world.personDid('ada');
    const key = randomUUID();
    const fields = { name: 'Across a restart', storageUri: 'file://keyed/across-a-restart.md', content: 'sent before a restart and after it\n' };
    const id = idOf(await world().upload(ada, fields, [], key));

    await world().restart();
    const before = await streams(world());
    const again = await world().upload(ada, fields, [], key);

    expect(again.status).toBe(200);
    expect(again.json).toEqual({ resourceId: id });
    expect(await streams(world())).toEqual(before);
    expect(world().stored(id).map((event) => event.type)).toEqual(['yield:created']);
  });
});
