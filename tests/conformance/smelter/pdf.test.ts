/**
 * What a Smelter does with a PDF (SMELTER.md § A PDF's text,
 * § The anchored-text store, § Rebuild): what it stores of the text it
 * derives and of where each word is on a page, what the Archivist then serves
 * from that store, and what it does when it is asked to derive anchored text
 * again. With it, what it signals of a PDF it has decided on, one it indexed
 * and one it declined (§ What it decides).
 *
 * What each kind of PDF becomes is specs/src/smelter/extraction-cases.json,
 * which every implementation runs through its own reader. The documents here
 * are a few lines of ASCII (support.ts), and a case looks for whole words of
 * them: never for a page's text as a whole, nor for where a space falls
 * between two words, in which readers differ.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { sha256, shardOf } from '../harness/archivist-world';
import { eachSmelter, type AnchoredTextEntry, type SmelterWorld } from '../harness/smelter-world';
import { NOT_A_PDF, pdfOf } from './support';

const PDF = 'application/pdf';

/** Two members of a point's payload, as specs/src/vectors/payload-cases.json names them: a chunk's text, and the mark of text that was read from pixels. */
const TEXT = 'text';
const MACHINE_READ = 'machineRead';

/** An entry of the anchored-text store that is a text, and not a decline. */
type StoredText = Exclude<AnchoredTextEntry, { declined: string }>;

/** What the store holds for bytes of this checksum, which is to be their text. */
function storedText(world: SmelterWorld, checksum: string): StoredText {
  const entry = world.anchoredEntry(checksum);
  if (entry === undefined || 'declined' in entry) {
    throw new Error(`the anchored-text store holds ${JSON.stringify(entry)} for the bytes ${checksum}, and not their text`);
  }
  return entry;
}

/**
 * The pages a stored text has a word on. A word is on a page when a run of the
 * text that is placed on that page has the word in it, which is what
 * specs/src/smelter/extraction-cases.json says of `onPage`. A run's offsets
 * count code points, and these documents are ASCII, where a string's own
 * positions are the same.
 */
function pagesStored(entry: StoredText, word: string): number[] {
  return entry.lines.flatMap((line) => (line.words.some(([, , start, end]) => entry.text.slice(start, end).includes(word)) ? [line.p] : []));
}

/** The pages the Archivist's answer has a word on, by its items as by the runs of an entry. */
function pagesServed(served: Record<string, unknown>, word: string): number[] {
  const text = served['text'] as string;
  const items = served['items'] as Array<{ start: number; end: number; page: number }>;
  return items.filter((item) => text.slice(item.start, item.end).includes(word)).map((item) => item.page);
}

/** The text of a resource's points, one chunk after another. */
async function indexedText(world: SmelterWorld, resourceId: string): Promise<string> {
  return (await world.index.pointsOf('resources', resourceId)).map((point) => String(point.payload[TEXT])).join('\n');
}

eachSmelter('a Smelter, given a PDF', (world) => {
  /** How many PDFs the cases have recorded so far. A rebuild that names no resource works through every one of them, whatever was decided of it. */
  let recorded = 0;

  /** Record bytes as a PDF, and wait for what the Smelter decides of them. */
  const recordedPdf = async (bytes: Buffer) => {
    const id = await world().created(bytes, PDF);
    recorded += 1;
    return { id, checksum: sha256(bytes), decision: await world().settled(id) };
  };

  it('reads a PDF with text of its own from that text: it is settled as indexed under the checksum of its bytes, its points have the words drawn, and none is marked as read from pixels', async () => {
    const { id, checksum, decision } = await recordedPdf(pdfOf([['A heron waits in the reedbed', 'while a kingfisher dives']]));

    expect(decision).toEqual({ resourceId: id, contentChecksum: checksum, outcome: 'indexed' });
    // `indexed` is signalled once the points are written.
    const text = await indexedText(world(), id);
    for (const word of ['heron', 'reedbed', 'kingfisher']) expect(text).toContain(word);
    for (const point of await world().index.pointsOf('resources', id)) expect(point.payload).not.toHaveProperty(MACHINE_READ);
  });

  it('stores what deriving a PDF\'s text came to under the checksum of its bytes: the text, and each word\'s place on its page, under the stamp the store states', async () => {
    const { checksum } = await recordedPdf(pdfOf([['An osprey circles', 'over the tideline']]));

    const entry = storedText(world(), checksum);
    for (const word of ['osprey', 'tideline']) {
      expect(entry.text).toContain(word);
      expect(pagesStored(entry, word), word).toEqual([1]);
    }
    // The Smelter states its stamp, which the Archivist keeps in the file `STAMP`, and its entries carry that one.
    expect(entry.stamp).toBe(world().anchoredStamp());
  });

  it('writes an entry the Archivist reads: the text it stored, with each word on its page, is what the Archivist then serves', async () => {
    const { id, checksum } = await recordedPdf(pdfOf([['A bittern booms', 'from the sedge']]));

    // What a Smelter wrote, the Archivist reads: the one contract of the store that outlives any one Smelter.
    const served = await world().kb.anchoredText(id);
    expect(served).toMatchObject({ kind: 'extracted', text: storedText(world(), checksum).text });
    for (const word of ['bittern', 'sedge']) {
      expect(served['text']).toContain(word);
      expect(pagesServed(served, word), word).toEqual([1]);
    }
  });

  it('places the words of a document of two pages each on its own page', async () => {
    const { id, checksum } = await recordedPdf(pdfOf([['A marten crosses the scree'], ['and a ptarmigan keeps still']]));

    const entry = storedText(world(), checksum);
    const served = await world().kb.anchoredText(id);
    expect(served).toMatchObject({ kind: 'extracted' });
    for (const [word, page] of [['marten', 1], ['scree', 1], ['ptarmigan', 2]] as const) {
      expect(pagesStored(entry, word), word).toEqual([page]);
      expect(pagesServed(served, word), word).toEqual([page]);
    }
  });

  it('declines a PDF whose pages draw nothing as having no text layer: it is skipped, has no points, and the decline is what is stored and served', async () => {
    const { id, checksum, decision } = await recordedPdf(pdfOf([[], []]));

    expect(decision).toEqual({ resourceId: id, contentChecksum: checksum, outcome: 'skipped', reason: 'no-text-layer' });
    expect(await world().index.pointsOf('resources', id)).toEqual([]);
    expect(world().anchoredEntry(checksum)).toMatchObject({ stamp: world().anchoredStamp(), declined: 'no-text-layer' });
    expect(await world().kb.anchoredText(id)).toEqual({ kind: 'declined', declined: 'no-text-layer' });
  });

  it('declines bytes that are no PDF, recorded as one, as corrupt: it is skipped, has no points, and the decline is what is stored and served', async () => {
    const { id, checksum, decision } = await recordedPdf(NOT_A_PDF);

    expect(decision).toEqual({ resourceId: id, contentChecksum: checksum, outcome: 'skipped', reason: 'corrupt' });
    expect(await world().index.pointsOf('resources', id)).toEqual([]);
    expect(world().anchoredEntry(checksum)).toMatchObject({ stamp: world().anchoredStamp(), declined: 'corrupt' });
    expect(await world().kb.anchoredText(id)).toEqual({ kind: 'declined', declined: 'corrupt' });
  });

  it('derives a resource\'s anchored text again when a rebuild names it: the lost entry is back, nothing is embedded, and its points are the ones it had', async () => {
    const { id, checksum } = await recordedPdf(pdfOf([['A dipper bobs on a wet stone']]));
    const entry = storedText(world(), checksum);
    const points = await world().index.pointsOf('resources', id, true);
    expect(points).not.toEqual([]);

    world().loseAnchoredEntry(checksum);
    const before = world().provider.mark();
    const answer = await world().rebuildAnchors(id);

    expect(answer).toMatchObject({ ok: true, channel: 'smelt:rebuild-anchors-ok' });
    expect(world().anchoredEntry(checksum)).toEqual(entry);
    expect(world().provider.since(before)).toEqual([]);
    // The index is not touched: the same points, by their ids, their payloads and their vectors.
    expect(await world().index.pointsOf('resources', id, true)).toEqual(points);
  });

  it('deletes nothing before it derives again: an entry that is there when a rebuild is asked for is there after it', async () => {
    const { id, checksum } = await recordedPdf(pdfOf([['A snipe drums over the fen']]));
    const entry = storedText(world(), checksum);

    expect(await world().rebuildAnchors(id)).toMatchObject({ ok: true, channel: 'smelt:rebuild-anchors-ok' });

    expect(world().anchoredEntry(checksum)).toEqual(entry);
  });

  it('derives the anchored text of every PDF again when a rebuild names none, and gives a resource whose text has no places on a page no entry', async () => {
    const first = await recordedPdf(pdfOf([['A curlew calls across the saltmarsh']]));
    const second = await recordedPdf(pdfOf([['A lapwing tumbles over the furrows']]));
    const decoded = 'A text that is decoded from its bytes has no places on a page.\n';
    const plain = await world().created(decoded, 'text/plain');
    await world().settled(plain);
    const entries = [storedText(world(), first.checksum), storedText(world(), second.checksum)];
    const points = await world().index.pointsOf('resources', plain, true);
    expect(points).not.toEqual([]);

    world().loseAnchoredEntry(first.checksum);
    world().loseAnchoredEntry(second.checksum);
    const before = world().provider.mark();
    // It works through every PDF the knowledge base holds, the earlier cases' too. Deriving a declined one again comes to its decline: an outcome, and no failure.
    const answer = await world().rebuildAnchors();

    expect(answer).toMatchObject({ ok: true, channel: 'smelt:rebuild-anchors-ok' });
    expect([world().anchoredEntry(first.checksum), world().anchoredEntry(second.checksum)]).toEqual(entries);
    expect(world().provider.since(before)).toEqual([]);
    // The text resource is as it was: no entry under the checksum of its bytes, and the points it had.
    expect(world().anchoredEntry(sha256(decoded))).toBeUndefined();
    expect(await world().index.pointsOf('resources', plain, true)).toEqual(points);
  });

  it('indexes a PDF although its entry cannot be written', async () => {
    const bytes = pdfOf([['A wren sings from the bracken']]);
    const checksum = sha256(bytes);
    // An entry is the file `<ab>/<cd>/<checksum>.json` of the store (AnchoredTextEntry). A file where
    // that directory would be leaves this entry nowhere to be written, and every other entry where it was.
    const inTheWay = join(world().kb.dirs.anchoredTextDir, ...shardOf(checksum).split('/'));
    mkdirSync(dirname(inTheWay), { recursive: true });
    writeFileSync(inTheWay, '');
    try {
      const { id, decision } = await recordedPdf(bytes);

      expect(decision).toEqual({ resourceId: id, contentChecksum: checksum, outcome: 'indexed' });
      expect(await indexedText(world(), id)).toContain('wren');
      // The entry was not written some other way: the case was of an entry that could not be.
      expect(world().anchoredEntry(checksum)).toBeUndefined();
    } finally {
      // Left in the way, it would fail every later rebuild of this resource's anchored text.
      rmSync(inTheWay, { recursive: true });
    }
  });

  // The last case of the file. It leaves the knowledge base holding a PDF whose bytes cannot be read, and every rebuild that names no resource would fail on it from here on.
  it('answers a rebuild that could not do every resource with how many of how many it could not, having done the rest and lost no entry', async () => {
    const done = await recordedPdf(pdfOf([['A dunlin probes the mudflat']]));
    const undone = await recordedPdf(pdfOf([['A redshank pipes on the strand']]));
    const restored = storedText(world(), done.checksum);
    const kept = storedText(world(), undone.checksum);

    world().loseAnchoredEntry(done.checksum);
    rmSync(world().contentFile(undone.id));
    const answer = await world().rebuildAnchors();

    expect(answer).toMatchObject({ ok: false, channel: 'smelt:rebuild-anchors-failed' });
    // One resource, of every PDF the knowledge base holds: the message says both numbers, and they are all a case reads of it.
    expect(String(answer.payload['message'])).toMatch(new RegExp(`\\b1 of ${recorded}\\b`));
    expect(world().anchoredEntry(done.checksum)).toEqual(restored);
    // Nothing was deleted first, so the entry of the one that could not be derived again is not lost.
    expect(world().anchoredEntry(undone.checksum)).toEqual(kept);
  });
});
