/**
 * How a Smelter asks its embedding provider for vectors (SMELTER.md § The
 * embedding provider), as far as that shows from outside: how many texts go
 * in one request, that an Ollama is asked for one thing at a time, and what
 * becomes of a resource when a request for it fails. With it, that what a
 * failed event left undone is found when the Smelter next starts (§ Order).
 *
 * The provider is the suite's stand-in for an Ollama. What a Smelter does
 * when that provider has not fetched its model yet is boot.test.ts's. That a
 * request has 15 seconds of its own is not held here, and nothing of Voyage.
 */
import { expect, it } from 'vitest';
import { eventually } from '../harness/net';
import { embeddingOf, sameEmbedding } from '../harness/ollama-embed';
import { EMBEDDING_MODEL, eachSmelter } from '../harness/smelter-world';

/** How many texts one request carries, at most. */
const SLICE = 128;

/**
 * How long a text is that is cut into more chunks than one request carries.
 * The world's Smelter cuts by a chunk size of 512 and an overlap of 64, which
 * specs/src/text/chunk-cases.json counts in code points, four to one: a chunk
 * is taken from a window of 2,048, and the next begins 256 before where it
 * was cut. A cut after a sentence's full stop may be one past its window, so
 * no chunk begins more than 1,793 after the one before, and the last begins
 * within 2,048 of the text's end. A text is therefore more than 128 chunks
 * when it is longer than 127 x 1,793 + 2,048 = 229,759 code points. This is
 * that, and a margin.
 */
const MORE_THAN_A_SLICE = 280_000;

/**
 * A text of numbered sentences, long enough to be cut into more chunks than
 * one request carries. No two of its sentences are the same, so no two of its
 * chunks are, and a vector given to another chunk than its own would show.
 */
function numbered(about: string): string {
  let text = '';
  for (let number = 1; text.length < MORE_THAN_A_SLICE; number++) text += `Sentence ${number} of ${about} says only that it is sentence ${number}. `;
  return text.trimEnd();
}

eachSmelter('a Smelter, asking its embedding provider', (world) => {
  it('cuts a batch of texts into slices of 128, each one request, and gives each text the vector that came back for it', async () => {
    const provider = world().provider;
    const before = provider.mark();
    const id = await world().created(numbered('the sliced text'), 'text/plain', { name: 'More than one slice' });
    // There is more to read, cut and write than for the short texts other cases record: it is given longer.
    expect(await world().settled(id, 1, 40_000)).toMatchObject({ outcome: 'indexed' });

    const points = await world().index.pointsOf('resources', id, true);
    const chunks = points.map((point) => String(point.payload['text']));
    expect(chunks.length).toBeGreaterThan(SLICE);
    expect(new Set(chunks).size).toBe(chunks.length);

    // The requests are the chunks, in their order, 128 to a request until they run out.
    const slices: string[][] = [];
    for (let from = 0; from < chunks.length; from += SLICE) slices.push(chunks.slice(from, from + SLICE));
    const sent = provider.since(before).map((request) => request.texts);
    expect(sent.map((texts) => texts.length)).toEqual(slices.map((slice) => slice.length));
    expect(sent).toEqual(slices);

    // Each chunk has the vector of its own text, though its text went in one request among many texts, and in one request of several.
    const astray = points.filter((point) => point.vector === undefined || !sameEmbedding(point.vector, embeddingOf(String(point.payload['text']))));
    expect(astray.map((point) => point.payload['chunkIndex'])).toEqual([]);
  });

  it('makes one request at a time of an Ollama, however many resources are being indexed', async () => {
    const provider = world().provider;
    const first = 'A text whose vector the provider is slow to give.';
    const second = 'A text recorded while the provider has not yet answered for another.';
    const before = provider.mark();
    // The next request is accepted and not answered; any after it is answered at once.
    provider.script({ hold: true });
    const slow = await world().created(first, 'text/plain', { name: 'Asked for first' });
    await eventually("the provider to be asked for the first text's vector", 10_000, () => (provider.held === 1 ? true : undefined));

    // A second resource is recorded while that request is unanswered. Were a request made for it now, it would be
    // answered, and the resource indexed: nothing is decided of it, and the provider has been asked once.
    const waiting = await world().created(second, 'text/plain', { name: 'Asked for second' });
    await world().unsettled(waiting);
    expect(provider.since(before).map((request) => request.texts)).toEqual([[first]]);
    expect(provider.held).toBe(1);

    // Answered well inside the 15 seconds a Smelter gives a request, the first is indexed, and then the second is asked for.
    provider.release();
    expect(await world().settled(slow)).toMatchObject({ outcome: 'indexed' });
    expect(await world().settled(waiting)).toMatchObject({ outcome: 'indexed' });
    expect(provider.since(before).map((request) => request.texts)).toEqual([[first], [second]]);
    expect(await world().index.pointsOf('resources', slow)).toHaveLength(1);
    expect(await world().index.pointsOf('resources', waiting)).toHaveLength(1);
  });

  it('gives a resource no points when a request of its batch fails, and finds the resource again when it next starts', async () => {
    const provider = world().provider;
    const text = numbered('the refused text');
    // The text's last sentence is in its last chunk and in no other, so the request that carries it is the last of the batch.
    const last = text.slice(text.lastIndexOf('Sentence '));
    const said = world().output.length;
    const before = provider.mark();
    provider.choose = (request) => (request.texts.some((chunk) => chunk.includes(last)) ? { status: 500, body: JSON.stringify({ error: 'the model failed' }) } : undefined);

    const refused = await world().created(text, 'text/plain', { name: 'Refused part way' });
    await eventually('the provider to have refused the last request of the batch', 40_000, () => (provider.since(before).some((request) => request.status === 500) ? true : undefined));
    // The request before it was answered with its vectors: the batch is failed by one request of two.
    expect(provider.since(before).map((request) => request.status)).toEqual([200, 500]);
    // It says which provider it asked, for which model, what status it was answered with, and which slice of the batch that was.
    await eventually('the Smelter to say which provider refused, which model, with what status, and which slice', 10_000, () =>
      world().output.slice(said).find((line) => line.includes('ollama') && line.includes(EMBEDDING_MODEL) && line.includes('500') && line.includes('slice')),
    );

    // The failure is passed by: what is recorded next is indexed.
    const next = await world().created('A text recorded after a request for another text failed.', 'text/plain', { name: 'Recorded after the refusal' });
    expect(await world().settled(next)).toMatchObject({ outcome: 'indexed' });
    // Nothing is decided of the resource whose request failed, and it has no points: not those of the chunks its first request embedded.
    await world().unsettled(refused);
    expect(await world().index.pointsOf('resources', refused)).toEqual([]);

    // What that event left undone is found when the Smelter next starts, with a provider that answers.
    await world().stop();
    provider.choose = undefined;
    await world().start();

    expect((await world().smelter.health()).reconcile).toMatchObject({ phase: 'done', summary: { resourcesEmbedded: 1, resourcesFailed: 0 } });
    expect(await world().settled(refused)).toMatchObject({ outcome: 'indexed' });
    expect((await world().index.pointsOf('resources', refused)).length).toBeGreaterThan(SLICE);
  });
});
