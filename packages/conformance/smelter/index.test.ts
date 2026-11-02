/**
 * The index a Smelter keeps as the record changes (SMELTER.md § What each
 * event does, § Indexing a resource, § Indexing an annotation, § What it
 * decides): what a text becomes in it when it is recorded, updated, archived
 * and unarchived, and an annotation when it is added, has its body changed
 * and is removed; what each point holds, as
 * specs/src/vectors/payload-cases.json states it; what the Smelter says it
 * decided of a resource, and of which bytes; and what it leaves as it was
 * when it cannot read a resource's bytes or have its text embedded. With it,
 * that an event it could not apply does not keep it from the next (§ Order).
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { sha256 } from '../harness/archivist-world';
import { eventually } from '../harness/net';
import { embeddingOf, sameEmbedding } from '../harness/ollama-embed';
import type { Point } from '../harness/qdrant';
import { eachSmelter } from '../harness/smelter-world';

/**
 * The id Qdrant keys a point by, worked out as payload-cases.json states it: the MD5 of a key's UTF-8 bytes, its 32
 * hexadecimal digits in a UUID's groups, with no bit changed. A chunk's key is its resource's id, a hyphen and the
 * chunk's index; an annotation's key is its id.
 */
function qdrantId(key: string): string {
  const hex = createHash('md5').update(key, 'utf8').digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** A point's id and its payload, whole: what the table states of a point, beside its vector. */
const stated = ({ id, payload }: Point) => ({ id, payload });

/** The media type every text of this file is recorded as, and so the one its points state its bytes were read as. */
const PLAIN = 'text/plain';

/** The point the table states for one chunk of a plain text, which was not read from pixels: it has no mark of that, and no other member. */
const chunkPoint = (resource: string, index: number, text: string, checksum: string, entityTypes: string[]) => ({
  id: qdrantId(`${resource}-${index}`),
  payload: { resourceId: resource, chunkIndex: index, text, contentChecksum: checksum, mediaType: PLAIN, entityTypes },
});

/** Whether a point's vector is the one the stand-in provider gives `text`: that text was embedded, and its vector landed on this point. */
const embeds = (point: Point | undefined, text: string): boolean => point?.vector !== undefined && sameEmbedding(point.vector, embeddingOf(text));

/**
 * A text comfortably longer than two chunks of the default size, 512. A chunk's size counts tokens, and a token is
 * four code points (specs/src/text/chunk-cases.json): two chunks are 4,096 code points, and this is more than 5,600
 * whatever it is about. No two of its sentences are the same, so no two of its chunks are.
 */
const longText = (about: string): string => Array.from({ length: 120 }, (_, n) => `Sentence ${n + 1} of ${about} is one of a hundred and twenty.`).join(' ');

/** A body by which an annotation states an entity type. */
const tagging = (entityType: string) => ({ type: 'TextualBody', value: entityType, purpose: 'tagging' });

eachSmelter('a Smelter, as the record changes', (world) => {
  /**
   * Record one event a Smelter follows, and wait until its health counts one more event applied than it did before:
   * what `record` answers. A case records through this, or waits as long itself, so that the count read before an
   * event is of every event recorded earlier, and the wait is for this one.
   */
  async function onceApplied<T>(record: () => Promise<T>): Promise<T> {
    const before = (await world().smelter.health()).eventsProcessed;
    const answer = await record();
    await world().applied(before + 1);
    return answer;
  }

  /** Record a text, and wait until the Smelter says it is indexed, under the checksum of those bytes: the resource's id. */
  async function indexed(text: string): Promise<string> {
    const resource = await onceApplied(() => world().created(text, PLAIN));
    expect(await world().settled(resource)).toEqual({ resourceId: resource, contentChecksum: sha256(text), outcome: 'indexed' });
    return resource;
  }

  it('indexes a text that is recorded: it says `indexed` of exactly the bytes recorded, once the points the table states are written', async () => {
    // A text within one chunk is that chunk, whole. Two of its characters are outside the basic plane, and are carried as themselves.
    const text = 'A treble clef 𝄞 opens the staff, and a note 🎵 follows it.\nThe staff has five lines.\n';
    const before = (await world().smelter.health()).eventsProcessed;
    const resource = await world().created(text, 'text/plain');

    expect(await world().settled(resource)).toEqual({ resourceId: resource, contentChecksum: sha256(text), outcome: 'indexed' });
    // The points are read as soon as the decision is heard, with no wait: it is signalled once they are written.
    const points = await world().index.pointsOf('resources', resource, true);
    expect(points.map(stated)).toEqual([chunkPoint(resource, 0, text, sha256(text), [])]);
    expect(embeds(points[0], text)).toBe(true);

    await world().applied(before + 1);
  });

  it('cuts a text longer than one chunk into several, has each embedded, and writes each as a point of its own, numbered from 0', async () => {
    const text = longText('a text that is cut');
    const asked = world().provider.mark();
    const resource = await indexed(text);

    const points = await world().index.pointsOf('resources', resource, true);
    const chunks = points.map((point) => String(point.payload['text']));
    // No chunk is longer than its size, so a text longer than two has more than two. Where each was cut is the chunk table's to say.
    expect(points.length).toBeGreaterThan(2);
    expect(points.map(stated)).toEqual(chunks.map((chunk, index) => chunkPoint(resource, index, chunk, sha256(text), [])));
    for (const chunk of chunks) expect(text).toContain(chunk);

    // The provider was sent those very texts, in their order, and each one's vector is on its own point.
    expect(world().provider.since(asked).flatMap((request) => request.texts)).toEqual(chunks);
    expect(points.filter((point) => !embeds(point, String(point.payload['text']))).map(stated)).toEqual([]);
  });

  it('indexes a resource again when its content is updated: the new bytes are settled under their own checksum, and no point of the old text is left', async () => {
    const resource = await indexed(longText('a text that grows shorter'));
    expect((await world().index.pointsOf('resources', resource)).length).toBeGreaterThan(2);

    const shorter = 'What is left of it is one chunk.\n';
    await onceApplied(() => world().updated(resource, shorter));

    expect(await world().settled(resource, 2)).toEqual({ resourceId: resource, contentChecksum: sha256(shorter), outcome: 'indexed' });
    const points = await world().index.pointsOf('resources', resource, true);
    expect(points.map(stated)).toEqual([chunkPoint(resource, 0, shorter, sha256(shorter), [])]);
    expect(embeds(points[0], shorter)).toBe(true);
  });

  it('takes an archived resource out of the index with the annotations on it, and puts both back when it is unarchived', async () => {
    const text = 'The Sauk crossed the Mississippi in April.\n';
    const resource = await indexed(text);
    const annotation = await onceApplied(() => world().annotated(resource, 'the Mississippi'));
    const annotations = await world().index.pointsOf('annotations', resource, true);
    expect(annotations.map((point) => point.payload['annotationId'])).toEqual([annotation]);

    await onceApplied(() => world().archived(resource));
    expect(await world().index.pointsOf('resources', resource)).toEqual([]);
    expect(await world().index.pointsOf('annotations', resource)).toEqual([]);

    // Unarchived, the resource is indexed as any is, and says so; then each annotation the record holds on it.
    await onceApplied(() => world().unarchived(resource));
    expect(await world().settled(resource, 2)).toEqual({ resourceId: resource, contentChecksum: sha256(text), outcome: 'indexed' });
    const points = await world().index.pointsOf('resources', resource, true);
    expect(points.map(stated)).toEqual([chunkPoint(resource, 0, text, sha256(text), [])]);
    expect(embeds(points[0], text)).toBe(true);
    const back = await world().index.pointsOf('annotations', resource, true);
    expect(back.map(stated)).toEqual(annotations.map(stated));
    expect(embeds(back[0], 'the Mississippi')).toBe(true);
  });

  it('gives no point to an annotation made on an archived resource, and gives it one when the resource is unarchived', async () => {
    const text = 'Keokuk stayed west of the river that spring.\n';
    const resource = await indexed(text);
    await onceApplied(() => world().archived(resource));

    // The record takes the annotation, and the Smelter applies its event: a start would take such a point out, so none is made.
    const annotation = await onceApplied(() => world().annotated(resource, 'Keokuk'));
    expect(await world().index.pointsOf('annotations', resource)).toEqual([]);

    await onceApplied(() => world().unarchived(resource));
    expect(await world().settled(resource, 2)).toEqual({ resourceId: resource, contentChecksum: sha256(text), outcome: 'indexed' });
    const back = await world().index.pointsOf('annotations', resource, true);
    expect(back.map((point) => point.payload['annotationId'])).toEqual([annotation]);
    expect(embeds(back[0], 'Keokuk')).toBe(true);
  });

  it('indexes an annotation that is added as one point, of the text it quotes, and takes the point out when the annotation is removed', async () => {
    const resource = await indexed('Black Hawk led the Sauk, and the war ended in 1832.\n');
    const annotation = await onceApplied(() => world().annotated(resource, 'Black Hawk', { motivation: 'linking', body: [tagging('Person'), tagging('Leader')] }));

    // The table's point of an annotation: its id, its resource's, its motivation, the entity types its body states in their order, and the text it quotes.
    const point = await world().index.annotationPoint(annotation, true);
    expect(point && stated(point)).toEqual({
      id: qdrantId(annotation),
      payload: { annotationId: annotation, resourceId: resource, motivation: 'linking', entityTypes: ['Person', 'Leader'], text: 'Black Hawk' },
    });
    expect(embeds(point, 'Black Hawk')).toBe(true);
    expect(await world().index.pointsOf('annotations', resource)).toHaveLength(1);

    await onceApplied(() => world().unannotated(resource, annotation));
    expect(await world().index.pointsOf('annotations', resource)).toEqual([]);
  });

  it("rewrites the entity types on an annotation's point when its body is given a tag, and embeds nothing", async () => {
    const resource = await indexed('Keokuk signed the treaty of 1832 at Fort Armstrong.\n');
    const annotation = await onceApplied(() => world().annotated(resource, 'Keokuk', { motivation: 'linking', body: [tagging('Person')] }));
    const asked = world().provider.mark();

    await onceApplied(() => world().bodyTagged(resource, annotation, ['Leader']));

    // The same point of the same text: only its entity types are other than they were, in the order its body now states them.
    const point = await world().index.annotationPoint(annotation, true);
    expect(point && stated(point)).toEqual({
      id: qdrantId(annotation),
      payload: { annotationId: annotation, resourceId: resource, motivation: 'linking', entityTypes: ['Person', 'Leader'], text: 'Keokuk' },
    });
    expect(embeds(point, 'Keokuk')).toBe(true);
    expect(world().provider.since(asked)).toEqual([]);
  });

  it('gives no point to an annotation that quotes no text, or only white space; and removing one that has no point changes nothing', async () => {
    const resource = await indexed('Wabokieshiek counselled the band to cross the river.\n');
    const quoting = await onceApplied(() => world().annotated(resource, 'Wabokieshiek'));
    const whole = await onceApplied(() => world().annotatedWhole(resource));
    await onceApplied(() => world().annotated(resource, ' \n\t'));

    // Each of the three has been applied, and the resource's one point of an annotation is of the one that quotes text.
    const points = await world().index.pointsOf('annotations', resource, true);
    expect(points.map((point) => point.payload['annotationId'])).toEqual([quoting]);

    await onceApplied(() => world().unannotated(resource, whole));
    expect(await world().index.pointsOf('annotations', resource, true)).toEqual(points);
  });

  it('rewrites the entity types on every point of a resource when one is added or removed, and asks its provider nothing', async () => {
    const resource = await indexed(longText('a text that is given entity types'));
    const before = await world().index.pointsOf('resources', resource, true);
    expect(before.length).toBeGreaterThan(2);
    const asked = world().provider.mark();
    // Each point as it was, its vector too, but for its entity types.
    const withTypes = (entityTypes: string[]) => before.map((point) => ({ ...point, payload: { ...point.payload, entityTypes } }));

    await onceApplied(() => world().tagged(resource, 'Person'));
    await onceApplied(() => world().tagged(resource, 'Event'));
    expect(world().entityTypes(resource)).toHaveLength(2);
    expect(await world().index.pointsOf('resources', resource, true)).toEqual(withTypes(world().entityTypes(resource)));

    await onceApplied(() => world().untagged(resource, 'Person'));
    expect(world().entityTypes(resource)).toEqual(['Event']);
    expect(await world().index.pointsOf('resources', resource, true)).toEqual(withTypes(['Event']));

    expect(world().provider.since(asked)).toEqual([]);
  });

  it('leaves a resource that has no points with none when it is given an entity type, and writes the type when the resource is next indexed', async () => {
    const text = 'Saukenuk stood where the Rock River meets the Mississippi.\n';
    const resource = await indexed(text);
    await onceApplied(() => world().archived(resource));
    expect(await world().index.pointsOf('resources', resource)).toEqual([]);

    await onceApplied(() => world().tagged(resource, 'Place'));
    expect(await world().index.pointsOf('resources', resource)).toEqual([]);

    // It is indexed next when it is unarchived, with the entity types the record holds of it then.
    await onceApplied(() => world().unarchived(resource));
    expect((await world().index.pointsOf('resources', resource)).map(stated)).toEqual([chunkPoint(resource, 0, text, sha256(text), ['Place'])]);
  });

  it('skips an image, whose media type has no text: it says `skipped` for `no-extractor`, and the image has no points', async () => {
    // The eight bytes a PNG begins with, and no more: nothing reads them.
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const resource = await onceApplied(() => world().created(image, 'image/png'));

    expect(await world().settled(resource)).toEqual({ resourceId: resource, contentChecksum: sha256(image), outcome: 'skipped', reason: 'no-extractor' });
    expect(await world().index.pointsOf('resources', resource)).toEqual([]);
  });

  it('skips a text of nothing but white space, for `empty`; and a resource that had points loses them when it is updated to such a text', async () => {
    const blank = ' \n\t\n';
    const resource = await onceApplied(() => world().created(blank, 'text/plain'));
    expect(await world().settled(resource)).toEqual({ resourceId: resource, contentChecksum: sha256(blank), outcome: 'skipped', reason: 'empty' });
    expect(await world().index.pointsOf('resources', resource)).toEqual([]);

    const had = await indexed('A text that is indexed, and then emptied.\n');
    expect(await world().index.pointsOf('resources', had)).toHaveLength(1);
    const emptied = '\n\n   \n';
    await onceApplied(() => world().updated(had, emptied));
    expect(await world().settled(had, 2)).toEqual({ resourceId: had, contentChecksum: sha256(emptied), outcome: 'skipped', reason: 'empty' });
    expect(await world().index.pointsOf('resources', had)).toEqual([]);
  });

  it('logs every skip as a warning, with the resource, the reason, the media type and the checksum', async () => {
    const image = Buffer.from('No picture, though it is recorded as one.', 'utf8');
    const blank = '\t\n \n';
    const skips: Array<[resource: string, reason: string, mediaType: string, checksum: string]> = [
      [await onceApplied(() => world().created(image, 'image/png')), 'no-extractor', 'image/png', sha256(image)],
      [await onceApplied(() => world().created(blank, 'text/plain')), 'empty', 'text/plain', sha256(blank)],
    ];

    // The page states no form for the line: it is found by the four things it must say, and held to say it is a warning.
    for (const said of skips) {
      const line = await eventually(`a line of its output that says ${said.join(', ')}`, 10_000, () => world().output.find((one) => said.every((part) => one.includes(part))));
      expect(line).toMatch(/warn/i);
    }
  });

  it('writes no point until every chunk is embedded: a resource whose new text could not be embedded keeps the points it had', async () => {
    const text = 'Keokuk kept his band west of the river.\n';
    const resource = await indexed(text);
    const before = await world().index.pointsOf('resources', resource, true);
    expect(before.map(stated)).toEqual([chunkPoint(resource, 0, text, sha256(text), [])]);

    // The provider fails every request that carries the new text.
    const refused = 'vectors the provider will not give';
    world().provider.choose = (request) =>
      request.texts.some((sent) => sent.includes(refused)) ? { status: 500, body: JSON.stringify({ error: 'the stand-in gives no vectors for this text' }) } : undefined;
    const asked = world().provider.mark();
    await world().updated(resource, `A text of ${refused}.\n`);
    await eventually('the provider to be asked for the vectors of the new text, and to fail the request', 20_000, () => world().provider.since(asked).find((request) => request.status === 500));

    // Nothing is said of the new bytes, and the points are still those of the old.
    await world().unsettled(resource, 2);
    expect(await world().index.pointsOf('resources', resource, true)).toEqual(before);
  });

  it('decides nothing of bytes it cannot read: it signals nothing and leaves the index as it was, and goes on to apply what is recorded next', async () => {
    const text = 'Black Hawk dictated his life to an interpreter.\n';
    const resource = await indexed(text);
    const before = await world().index.pointsOf('resources', resource, true);
    expect(before.map(stated)).toEqual([chunkPoint(resource, 0, text, sha256(text), [])]);

    // The bytes are taken from where the record says they are stored: the Archivist has none to serve. An unarchive
    // is then recorded, which makes a Smelter index the resource and so read its bytes. The resource was never
    // archived, so its points are in the index when that read fails.
    rmSync(world().contentFile(resource));
    const written = world().output.length;
    await world().unarchived(resource);
    // The failure is logged: a line written since names the resource, and says it is a warning or an error.
    await eventually('a line of its output that says it could not read the bytes of the resource', 20_000, () =>
      world().output.slice(written).find((line) => line.includes(resource) && /warn|error/i.test(line)),
    );

    // It goes on: to the next event of that resource, which is applied after the one that failed, and to another resource's.
    const quoted = await world().annotated(resource, 'an interpreter');
    const next = await world().created('Recorded after bytes that could not be read.\n', 'text/plain');
    await eventually('the point of an annotation recorded after the bytes could not be read', 20_000, () => world().index.annotationPoint(quoted));
    expect(await world().settled(next)).toMatchObject({ outcome: 'indexed' });
    expect(await world().index.pointsOf('resources', next)).toHaveLength(1);

    // Nothing was decided of the bytes it could not read, and the resource's points are those of the bytes it last read.
    await world().unsettled(resource, 2);
    expect(await world().index.pointsOf('resources', resource, true)).toEqual(before);
  });
});
