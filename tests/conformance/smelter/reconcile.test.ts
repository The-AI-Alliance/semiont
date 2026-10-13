/**
 * What a Smelter finds and mends when it starts (SMELTER.md § Reconcile). Each
 * case stops the Smelter, changes the index, the record or the anchored-text
 * store behind its back, starts it again, and reads what the two stores then
 * hold, what its embedding provider was asked, and what its health reports of
 * the pass. With it, that the work of a reconcile is no event (§ Health), and
 * that an index another cut made is made again (§ Boot).
 *
 * The work a start plans is stated, difference by difference, in
 * specs/src/smelter/reconcile-cases.json, which each implementation runs
 * through its own planner. These cases hold that the work is then done.
 */
import { expect, it } from 'vitest';
import { sha256 } from '../harness/archivist-world';
import { eventually } from '../harness/net';
import { embeddingOf, sameEmbedding } from '../harness/ollama-embed';
import type { Point } from '../harness/qdrant';
import type { ReconcileSummary } from '../harness/smelter-process';
import { eachSmelter, type SmelterWorld } from '../harness/smelter-world';
import { pdfOf } from './support';

/** A PDF a case has recorded: its resource, and the checksum of its bytes, which its anchored text is stored under. */
interface RecordedPdf {
  id: string;
  checksum: string;
}

/** Record a resource of plain text, and wait until the Smelter has indexed it: its id. */
async function indexedText(world: SmelterWorld, name: string, text: string): Promise<string> {
  const id = await world.created(text, 'text/plain', { name });
  expect(await world.settled(id)).toMatchObject({ outcome: 'indexed' });
  return id;
}

/** Record a PDF of one page that draws `lines`, and wait until the Smelter has indexed it. */
async function indexedPdf(world: SmelterWorld, name: string, lines: readonly string[]): Promise<RecordedPdf> {
  const bytes = pdfOf([lines]);
  const checksum = sha256(bytes);
  const id = await world.created(bytes, 'application/pdf', { name });
  expect(await world.settled(id)).toMatchObject({ outcome: 'indexed', contentChecksum: checksum });
  return { id, checksum };
}

/** Record an annotation that quotes `exact`, and wait until the index holds its point: its id. A Smelter signals nothing of an annotation. */
async function indexedAnnotation(world: SmelterWorld, resourceId: string, exact: string): Promise<string> {
  const id = await world.annotated(resourceId, exact);
  await eventually(`the index to hold the point of the annotation ${id}`, 20_000, () => world.index.annotationPoint(id));
  return id;
}

/** An annotation's point, with its vector. The case fails here when the index holds none. */
async function pointOfAnnotation(world: SmelterWorld, annotationId: string): Promise<Point> {
  const point = await world.index.annotationPoint(annotationId, true);
  if (point === undefined) throw new Error(`the index holds no point of the annotation ${annotationId}`);
  return point;
}

/** What the reconcile of the Smelter's last start came to. One that did not end well has no summary, and fails the case here. */
async function summaryOf(world: SmelterWorld): Promise<ReconcileSummary> {
  const { reconcile } = await world.smelter.health();
  if (reconcile.phase !== 'done' || reconcile.summary === undefined) throw new Error(`the Smelter's reconcile did not end well: ${JSON.stringify(reconcile)}`);
  return reconcile.summary;
}

/**
 * Hold a reconcile to have done `work` and no other. Its two counts of what
 * the knowledge base holds are no work, and are left as it reports them: the
 * cases of this file share one knowledge base, so a case holds those two only
 * where it knows them, or as it changes them.
 */
function expectOnly(summary: ReconcileSummary, work: Partial<ReconcileSummary>): void {
  expect(summary).toEqual({
    resourcesEmbedded: 0,
    resourcesSkipped: {},
    resourcesUnavailable: 0,
    resourcesFailed: 0,
    resourcesRestamped: 0,
    resourcesReanchored: 0,
    resourceVectorsDeleted: 0,
    annotationsEmbedded: 0,
    annotationsRestamped: 0,
    annotationVectorsDeleted: 0,
    resourcesEligible: summary.resourcesEligible,
    resourcesIndexed: summary.resourcesIndexed,
    ...work,
  });
}

/** A point's vector. Every point compared here was read with its vector. */
function vectorOf(point: Point): number[] {
  if (point.vector === undefined) throw new Error(`the point ${point.id} was read without its vector`);
  return point.vector;
}

/** What points hold beside their vectors: their ids and their payloads. */
const carried = (points: readonly Point[]) => points.map(({ id, payload }) => ({ id, payload }));

/** Hold `now` to be the points that `before` were: their ids and payloads the same, and their vectors the same to the precision an index stores one in. */
function expectSame(now: readonly Point[], before: readonly Point[]): void {
  expect(carried(now)).toEqual(carried(before));
  expect(now.every((point, at) => sameEmbedding(vectorOf(point), vectorOf(before[at]!)))).toBe(true);
}

eachSmelter('a Smelter, starting after what it keeps was changed behind it', (world) => {
  /** Every PDF the cases so far have recorded. None is changed or archived afterwards, so each has points of its bytes, and one entry in the anchored-text store. */
  const pdfs: RecordedPdf[] = [];

  it('fills again, whole, an index that was cleared', async () => {
    const texts = [
      'The first of three texts is quoted by an annotation, in these words and no others.',
      'The second of three texts is quoted by nothing.',
      'The third of three texts is the last of them.',
    ];
    const ids: string[] = [];
    for (const [at, text] of texts.entries()) ids.push(await indexedText(world(), `Cleared, text ${at + 1}`, text));
    // A resource whose media type has no text is of the catalog, and is none of the resources a Smelter indexes.
    const image = await world().created(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png', { name: 'Cleared, a picture' });
    await world().settled(image);
    const quote = 'in these words and no others';
    const annotation = await indexedAnnotation(world(), ids[0]!, quote);
    const held = await Promise.all(ids.map((id) => world().index.pointsOf('resources', id, true)));
    const heldOfAnnotation = await pointOfAnnotation(world(), annotation);

    await world().stop();
    await world().clearIndex();
    const before = world().provider.mark();
    await world().start();

    // Nothing was recorded before this case: the three texts are every resource of the catalog that has text, and the annotation is every annotation.
    expectOnly(await summaryOf(world()), { resourcesEmbedded: 3, annotationsEmbedded: 1, resourcesEligible: 3, resourcesIndexed: 3 });
    for (const [at, id] of ids.entries()) expectSame(await world().index.pointsOf('resources', id, true), held[at]!);
    expectSame([await pointOfAnnotation(world(), annotation)], [heldOfAnnotation]);
    expect(await world().index.count('resources')).toBe(3);
    expect(await world().index.count('annotations')).toBe(1);

    // The provider is asked for each text once, and for the first text before the words quoted from it: a resource is
    // indexed before an annotation on it. What else it is asked, to learn how wide its vectors are, is not this case's.
    const asked = world().provider.since(before).flatMap((request) => request.texts);
    const wanted = [...texts, quote];
    expect(asked.filter((text) => wanted.includes(text)).sort()).toEqual([...wanted].sort());
    expect(asked.indexOf(texts[0]!)).toBeLessThan(asked.indexOf(quote));
  });

  it('indexes again a resource whose points were taken out behind it, and touches no other', async () => {
    const text = 'The points of this text are taken out of the index while the Smelter is stopped.';
    const emptied = await indexedText(world(), 'Emptied', text);
    const other = await indexedText(world(), 'Beside the emptied', 'The points of this text are left where they are.');
    const held = await world().index.pointsOf('resources', emptied, true);
    const heldOfOther = await world().index.pointsOf('resources', other, true);

    await world().stop();
    await world().index.deletePointsOf('resources', emptied);
    expect(await world().index.pointsOf('resources', emptied)).toEqual([]);
    const before = world().provider.mark();
    await world().start();

    expectOnly(await summaryOf(world()), { resourcesEmbedded: 1 });
    // The index was there when it started, so it asks nothing to learn how wide a vector is: its one request is for the text whose points were gone.
    expect(world().provider.since(before).map((request) => request.texts)).toEqual([[text]]);
    expectSame(await world().index.pointsOf('resources', emptied, true), held);
    expectSame(await world().index.pointsOf('resources', other, true), heldOfOther);
  });

  it('indexes again, under the new checksum, a resource whose bytes changed while it was stopped', async () => {
    const id = await indexedText(world(), 'Changed', 'What this resource said before the Smelter stopped.');
    const changed = 'What this resource says now, which was written while the Smelter was stopped.';

    await world().stop();
    const checksum = await world().updated(id, changed);
    const before = world().provider.mark();
    await world().start();

    expectOnly(await summaryOf(world()), { resourcesEmbedded: 1 });
    expect(world().provider.since(before).map((request) => request.texts)).toEqual([[changed]]);
    const points = await world().index.pointsOf('resources', id, true);
    expect(points.map((point) => point.payload)).toMatchObject([{ text: changed, contentChecksum: checksum }]);
    expect(points.every((point) => sameEmbedding(vectorOf(point), embeddingOf(changed)))).toBe(true);
    // It says what it decided of the new bytes, as it does of any bytes it indexes.
    expect(await world().settled(id, 2)).toMatchObject({ outcome: 'indexed', contentChecksum: checksum });
  });

  it('rewrites the entity types on the points of a resource that was given one while it was stopped, and embeds nothing', async () => {
    const id = await indexedText(world(), 'Given an entity type', 'A text that is given an entity type while the Smelter is stopped.');
    const held = await world().index.pointsOf('resources', id, true);
    expect(held.map((point) => point.payload['entityTypes'])).toEqual([[]]);

    await world().stop();
    await world().tagged(id, 'Treaty');
    const before = world().provider.mark();
    await world().start();

    expectOnly(await summaryOf(world()), { resourcesRestamped: 1 });
    expect(world().provider.since(before)).toEqual([]);
    // The same points, with the same vectors: only the entity types they carry are other than they were.
    expectSame(
      await world().index.pointsOf('resources', id, true),
      held.map((point) => ({ ...point, payload: { ...point.payload, entityTypes: ['Treaty'] } })),
    );
  });

  it('derives again the anchored text of a PDF whose entry was lost, and neither embeds nor touches its points', async () => {
    const pdf = await indexedPdf(world(), 'Lost its anchored text', ['A page whose text is read from the page itself.', 'Where each run of it is on the page is stored beside it.']);
    pdfs.push(pdf);
    const entry = world().anchoredEntry(pdf.checksum);
    expect(entry).toBeDefined();
    const held = await world().index.pointsOf('resources', pdf.id, true);

    await world().stop();
    world().loseAnchoredEntry(pdf.checksum);
    const before = world().provider.mark();
    await world().start();

    expectOnly(await summaryOf(world()), { resourcesReanchored: 1 });
    expect(world().anchoredEntry(pdf.checksum)).toEqual(entry);
    expect(world().provider.since(before)).toEqual([]);
    expectSame(await world().index.pointsOf('resources', pdf.id, true), held);
    // Its points were not made again, so nothing is decided of it a second time.
    await world().unsettled(pdf.id, 2);
  });

  it('takes out the points of a resource that was archived while it was stopped, and of the annotations on it', async () => {
    const archived = await indexedText(world(), 'Archived', 'A text that is archived while the Smelter is stopped, with what is quoted from it.');
    const onArchived = await indexedAnnotation(world(), archived, 'what is quoted from it');
    const kept = await indexedText(world(), 'Beside the archived', 'A text that stays, with the words an annotation quotes from it.');
    const onKept = await indexedAnnotation(world(), kept, 'the words an annotation quotes');
    const heldOfKept = await world().index.pointsOf('resources', kept, true);
    const heldOnKept = await pointOfAnnotation(world(), onKept);
    // A start that finds nothing to mend reports what the knowledge base holds before the resource is archived.
    await world().restart();
    const was = await summaryOf(world());
    expectOnly(was, {});

    await world().stop();
    await world().archived(archived);
    await world().start();

    const summary = await summaryOf(world());
    expectOnly(summary, { resourceVectorsDeleted: 1, annotationVectorsDeleted: 1 });
    // An archived resource is none of the catalog's: one fewer of its resources has text, and one fewer has points.
    expect(summary.resourcesEligible).toBe(was.resourcesEligible - 1);
    expect(summary.resourcesIndexed).toBe(was.resourcesIndexed - 1);
    expect(await world().index.pointsOf('resources', archived)).toEqual([]);
    expect(await world().index.pointsOf('annotations', archived)).toEqual([]);
    expect(await world().index.annotationPoint(onArchived)).toBeUndefined();
    expectSame(await world().index.pointsOf('resources', kept, true), heldOfKept);
    expectSame([await pointOfAnnotation(world(), onKept)], [heldOnKept]);
  });

  it('rewrites the entity types on the point of an annotation whose body was given a tag while it was stopped, and embeds nothing', async () => {
    const quote = 'words whose annotation is given an entity type';
    const id = await indexedText(world(), 'Tagged in its body while stopped', `A text with ${quote} while the Smelter is stopped.`);
    const annotation = await indexedAnnotation(world(), id, quote);
    const held = await pointOfAnnotation(world(), annotation);
    expect(held.payload['entityTypes']).toEqual([]);

    await world().stop();
    await world().bodyTagged(id, annotation, ['Treaty']);
    const before = world().provider.mark();
    await world().start();

    expectOnly(await summaryOf(world()), { annotationsRestamped: 1 });
    expect(world().provider.since(before)).toEqual([]);
    // The same point, with the same vector: only the entity types it carries are other than they were.
    const point = await pointOfAnnotation(world(), annotation);
    expectSame([{ ...point, payload: { ...point.payload, entityTypes: [] } }], [held]);
    expect(point.payload['entityTypes']).toEqual(['Treaty']);
  });

  it('indexes an annotation added while it was stopped, and takes out the point of one removed', async () => {
    const id = await indexedText(world(), 'Annotated while stopped', 'A text with words quoted before the Smelter stopped, and other words quoted after.');
    const removed = await indexedAnnotation(world(), id, 'words quoted before the Smelter stopped');
    const quote = 'other words quoted after';

    await world().stop();
    const added = await world().annotated(id, quote);
    await world().unannotated(id, removed);
    const before = world().provider.mark();
    await world().start();

    expectOnly(await summaryOf(world()), { annotationsEmbedded: 1, annotationVectorsDeleted: 1 });
    expect(world().provider.since(before).map((request) => request.texts)).toEqual([[quote]]);
    const point = await pointOfAnnotation(world(), added);
    expect(point.payload).toMatchObject({ annotationId: added, resourceId: id, text: quote });
    expect(sameEmbedding(vectorOf(point), embeddingOf(quote))).toBe(true);
    expect(await world().index.annotationPoint(removed)).toBeUndefined();
  });

  it('fills again an anchored-text store that was cleared, deriving again the anchored text of every PDF', async () => {
    pdfs.push(await indexedPdf(world(), 'Cleared, a first document', ['The first of two documents recorded before the store was cleared.']));
    pdfs.push(await indexedPdf(world(), 'Cleared, a second document', ['The second of two documents recorded before the store was cleared.']));
    const files = world().anchoredFiles();
    const entries = pdfs.map(({ checksum }) => world().anchoredEntry(checksum));
    expect(entries).not.toContain(undefined);
    const held = await Promise.all(pdfs.map(({ id }) => world().index.pointsOf('resources', id, true)));

    await world().stop();
    world().clearAnchoredText();
    expect(world().anchoredFiles()).toEqual([]);
    const before = world().provider.mark();
    await world().start();

    // Every PDF still has points of its bytes, so none is indexed again: each has its anchored text derived again, and that is all the pass does.
    expectOnly(await summaryOf(world()), { resourcesReanchored: pdfs.length });
    expect(world().provider.since(before)).toEqual([]);
    expect(pdfs.map(({ checksum }) => world().anchoredEntry(checksum))).toEqual(entries);
    expect(world().anchoredFiles()).toEqual(files);
    for (const [at, { id }] of pdfs.entries()) expectSame(await world().index.pointsOf('resources', id, true), held[at]!);
  });

  it('counts none of the work of its reconcile among the events it has applied', async () => {
    const id = await indexedText(world(), 'Indexed again, and not counted', 'A text whose points are made again by a reconcile, which is no event.');

    await world().stop();
    await world().index.deletePointsOf('resources', id);
    await world().start();

    expectOnly(await summaryOf(world()), { resourcesEmbedded: 1 });
    expect((await world().smelter.health()).eventsProcessed).toBe(0);
    // What is recorded next is an event, and is counted.
    await indexedText(world(), 'Recorded after, and counted', 'A text recorded after the Smelter started, which is an event.');
    expect((await world().applied(1)).eventsProcessed).toBe(1);
  });

  it('does not read again, or decide again, a text it remembers skipping', async () => {
    const id = await world().created(' \n\t\n', 'text/plain', { name: 'Nothing but white space' });
    expect(await world().settled(id)).toMatchObject({ outcome: 'skipped', reason: 'empty' });
    expect(await world().index.pointsOf('resources', id)).toEqual([]);

    await world().stop();
    const before = world().provider.mark();
    await world().start();

    // Its media type has text and it has no points, and still it is not set out to be indexed: nothing is skipped again, and nothing is signalled of it again.
    expectOnly(await summaryOf(world()), {});
    expect(world().provider.since(before)).toEqual([]);
    expect(world().settledSignals(id)).toHaveLength(1);
  });

  it('makes its index again, and indexes everything again, when it is started to cut a text by other numbers', async () => {
    const text = 'A text that is indexed, and indexed again by a Smelter that cuts a text by other numbers.';
    const id = await indexedText(world(), 'Cut by other numbers', text);
    const quote = 'indexed again by a Smelter';
    const annotation = await indexedAnnotation(world(), id, quote);
    const held = await world().index.pointsOf('resources', id, true);
    const heldOfAnnotation = await pointOfAnnotation(world(), annotation);
    const settings = world().launch().settings;

    await world().stop();
    const before = world().provider.mark();
    await world().start({ settings: { ...settings, chunking: { chunkSize: 256, overlap: 32 } } });

    // The index said another cut made it. Every resource whose media type has text is set out to be indexed again, and each is indexed or skipped.
    const summary = await summaryOf(world());
    const skipped = Object.values(summary.resourcesSkipped).reduce((sum, count) => sum + count, 0);
    expect(summary.resourcesEmbedded + skipped).toBe(summary.resourcesEligible);
    expect([summary.resourcesUnavailable, summary.resourcesFailed]).toEqual([0, 0]);
    expect(summary.annotationsEmbedded).toBeGreaterThan(0);
    const asked = world().provider.since(before).flatMap((request) => request.texts);
    expect(asked).toContain(text);
    expect(asked).toContain(quote);
    // A text this short is one chunk by either cut: its point is as it was, and so is the annotation's.
    expectSame(await world().index.pointsOf('resources', id, true), held);
    expectSame([await pointOfAnnotation(world(), annotation)], [heldOfAnnotation]);

    // Started as it was before, it finds an index the other cut made, and makes it again: the index is as this world's Smelter makes one.
    await world().stop();
    const again = world().provider.mark();
    await world().start();
    expect(world().provider.since(again).flatMap((request) => request.texts)).toContain(text);
    expect((await summaryOf(world())).resourcesEmbedded).toBe(summary.resourcesEmbedded);
  });
});
