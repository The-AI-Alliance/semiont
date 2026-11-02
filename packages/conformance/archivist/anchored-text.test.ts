/**
 * The anchored-text store, as the Smelter keeps it (ARCHIVIST.md § The
 * anchored-text store, § HTTP surface): the stamp it states, an entry it
 * stores for a resource's bytes, the entry it reads back by checksum, and the
 * keys it lists. Each over the Archivist's surface, as a service account.
 */
import { expect, it } from 'vitest';
import { anchoredEntry, sha256, withArchivist } from '../harness/archivist-world';
import { archivistSpec } from '../harness/spec';

const STAMP = 'conformance-reader-1+conformance-engine-1';

function entryOf(text: string, stamp = STAMP): Record<string, unknown> {
  return { v: 3, stamp, ...anchoredEntry(text) };
}

withArchivist('the anchored-text store', (world) => {
  it('stores an entry for a resource\'s bytes, which a reader then gets for that resource and for another with the same bytes', async () => {
    const reader = world().world.personDid('reader');
    const content = Buffer.from('%PDF-1.4 stored through the surface\n');
    const first = await world().created(reader, { name: 'First', storageUri: 'file://scans/first.pdf', format: 'application/pdf', content });
    const second = await world().created(reader, { name: 'Second', storageUri: 'file://scans/second.pdf', format: 'application/pdf', content });

    await world().stateStamp(STAMP);
    const stored = await world().storeAnchoredText(first, { contentChecksum: sha256(content), entry: entryOf('alpha beta') });
    expect(stored.status).toBe(204);

    for (const id of [first, second]) {
      expect(await world().anchoredText(id)).toMatchObject({ kind: 'extracted', text: 'alpha beta', method: 'ocr' });
    }

    // A second write for the same bytes replaces the first.
    expect((await world().storeAnchoredText(second, { contentChecksum: sha256(content), entry: entryOf('gamma delta') })).status).toBe(204);
    expect(await world().anchoredText(first)).toMatchObject({ kind: 'extracted', text: 'gamma delta' });
  });

  it('answers the entry stored for a resource\'s content at once, as it was stored, 404 for content it has none of without waiting for the Smelter, and 409 for content the resource does not have', async () => {
    const reader = world().world.personDid('reader');
    const content = Buffer.from('%PDF-1.4 read back by checksum\n');
    const id = await world().created(reader, { name: 'Read back', storageUri: 'file://scans/read-back.pdf', format: 'application/pdf', content });
    await world().stateStamp(STAMP);
    const entry = entryOf('read back');
    expect((await world().storeAnchoredText(id, { contentChecksum: sha256(content), entry })).status).toBe(204);

    const held = await world().storedAnchoredText(id, sha256(content));
    expect(held.status).toBe(200);
    expect(held.json).toEqual(entry);

    // Bytes with no entry, of a resource nothing has settled: answered at once.
    const unread = Buffer.from('%PDF-1.4 never derived\n');
    const never = await world().created(reader, { name: 'Never derived', storageUri: 'file://scans/never.pdf', format: 'application/pdf', content: unread });
    const asked = Date.now();
    expect((await world().storedAnchoredText(never, sha256(unread))).status).toBe(404);
    expect(Date.now() - asked).toBeLessThan(5_000);

    // Read with a checksum the resource's content does not have: refused, naming the one it has.
    const stale = await world().storedAnchoredText(id, sha256(unread));
    expect(stale.status).toBe(409);
    expect((stale.json as { error: string }).error).toContain(sha256(content));

    // Read with no checksum, or one that is none.
    expect((await world().storedAnchoredText(id, undefined)).status).toBe(400);
    expect((await world().storedAnchoredText(id, 'ABC')).status).toBe(400);
  });

  it('lists the keys stored under the stamp last stated, and answers nothing stored under another', async () => {
    const reader = world().world.personDid('reader');
    const bytes = ['one', 'two', 'three'].map((n) => Buffer.from(`%PDF-1.4 listed ${n}\n`));
    const ids = await Promise.all(bytes.map((content, i) => world().created(reader, { name: `Listed ${i}`, storageUri: `file://scans/listed-${i}.pdf`, format: 'application/pdf', content })));
    const [a, b, c] = bytes.map((content) => sha256(content)) as [string, string, string];

    await world().stateStamp('stamp-before');
    for (const i of [0, 1]) {
      expect((await world().storeAnchoredText(ids[i]!, { contentChecksum: sha256(bytes[i]!), entry: entryOf(`before ${i}`, 'stamp-before') })).status).toBe(204);
    }
    expect(await world().anchoredTextKeys()).toEqual(expect.arrayContaining([a, b].sort()));
    expect(await world().anchoredTextKeys()).not.toContain(c);

    // A new stamp: what was stored under the old one is listed and answered to no one; nothing is deleted.
    await world().stateStamp('stamp-after');
    expect(await world().anchoredTextKeys()).toEqual([]);
    expect((await world().storedAnchoredText(ids[0]!, a)).status).toBe(404);
    expect((await world().storeAnchoredText(ids[2]!, { contentChecksum: c, entry: entryOf('after', 'stamp-after') })).status).toBe(204);
    expect(await world().anchoredTextKeys()).toEqual([c]);

    // The old stamp stated again: its entries are there.
    await world().stateStamp('stamp-before');
    expect(await world().anchoredTextKeys()).toEqual([a, b].sort());
    expect((await world().storedAnchoredText(ids[0]!, a)).status).toBe(200);
  });

  it('keeps the stamp it was told across a restart', async () => {
    const reader = world().world.personDid('reader');
    const content = Buffer.from('%PDF-1.4 kept across a restart\n');
    const id = await world().created(reader, { name: 'Kept', storageUri: 'file://scans/kept.pdf', format: 'application/pdf', content });
    await world().stateStamp('stamp-kept');
    expect((await world().storeAnchoredText(id, { contentChecksum: sha256(content), entry: entryOf('kept', 'stamp-kept') })).status).toBe(204);

    await world().restart();
    expect((await world().storedAnchoredText(id, sha256(content))).status).toBe(200);
    expect(await world().anchoredText(id)).toMatchObject({ kind: 'extracted', text: 'kept' });
  });

  it('refuses a write for bytes the resource does not have, for a resource the record does not hold, and a body that is no write', async () => {
    const reader = world().world.personDid('reader');
    const content = Buffer.from('%PDF-1.4 the bytes the resource has\n');
    const id = await world().created(reader, { name: 'Changed', storageUri: 'file://scans/changed.pdf', format: 'application/pdf', content });
    await world().stateStamp(STAMP);

    const other = sha256(Buffer.from('%PDF-1.4 bytes it does not have\n'));
    const stale = await world().storeAnchoredText(id, { contentChecksum: other, entry: entryOf('stale') });
    expect(stale.status).toBe(409);
    expect((stale.json as { error: string }).error).toContain(sha256(content));


    const unheld = await world().storeAnchoredText('c'.repeat(32), { contentChecksum: sha256(content), entry: entryOf('nowhere') });
    expect(unheld.status).toBe(404);

    for (const body of [
      { contentChecksum: sha256(content) },
      { contentChecksum: 'not-a-checksum', entry: entryOf('bad key') },
      { contentChecksum: sha256(content), entry: { ...entryOf('old form'), v: 2 } },
      { contentChecksum: sha256(content), entry: entryOf('extra'), extra: true },
    ]) {
      expect((await world().storeAnchoredText(id, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await world().storedAnchoredText(id, sha256(content))).status).toBe(404);

    expect((await world().http('PUT', '/anchored-text/stamp', { json: { stamp: 'two words' }, route: '/anchored-text/stamp' })).status).toBe(400);
    // A body larger than the operation's maxBodyBytes, as the Archivist's API states it.
    const limit = archivistSpec().limits('put', '/anchored-text/stamp')['maxBodyBytes']!;
    const oversized = await world().http('PUT', '/anchored-text/stamp', { json: { stamp: 's'.repeat(limit) }, route: '/anchored-text/stamp' });
    expect(oversized.status).toBe(413);
  });

  it('admits each of its four operations only with semiont-service', async () => {
    const reader = world().world.personDid('reader');
    const content = Buffer.from('%PDF-1.4 admitted only as a service\n');
    const id = await world().created(reader, { name: 'Admitted', storageUri: 'file://scans/admitted.pdf', format: 'application/pdf', content });
    const roleless = await world().serviceToken([]);
    const calls = [
      () => world().http('PUT', '/anchored-text/stamp', { json: { stamp: STAMP }, route: '/anchored-text/stamp', token: roleless }),
      () => world().storeAnchoredText(id, { contentChecksum: sha256(content), entry: entryOf('refused') }, { token: roleless }),
      () => world().storedAnchoredText(id, sha256(content), { token: roleless }),
      () => world().http('GET', '/anchored-text/entries', { route: '/anchored-text/entries', token: roleless }),
    ];
    for (const call of calls) expect((await call()).status).toBe(401);
    expect((await world().http('GET', '/anchored-text/entries', { route: '/anchored-text/entries', anonymous: true })).status).toBe(401);
  });
});
