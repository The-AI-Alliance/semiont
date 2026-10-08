/**
 * A text too long for one request (WORKER-SERVICE.md § Pieces,
 * § Committing, and where a job stands): cut into pieces that overlap, each
 * asked for, committed and checkpointed in turn, with a span two pieces both
 * see recorded once.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, LONG_TEXT, markerHighlight, markJob, report, settled, SMALL_CONTEXT_LENGTH, withoutCreated } from './support';

/** What each request is given to answer in, and the window it is sized to: the model's whole window. */
const REQUEST = { num_predict: 622, num_ctx: SMALL_CONTEXT_LENGTH, temperature: 0 };
/** The size, in tokens, every piece is cut at: the provider reports no usage, so the size never moves. */
const CHUNK_SIZE = 311;

const found = (...markers: number[]) => ({ response: JSON.stringify(markers.map((n) => ({ exact: `marker ${n}` }))) });

eachWorkerService('a job over a long text', (world) => {
  it('cuts the text into overlapping pieces at paragraph ends, and asks, commits and checkpoints piece by piece', async () => {
    const w = world();
    const agent = w.agents[0]!;
    w.ollama.show = { contextLength: SMALL_CONTEXT_LENGTH };
    const job = markJob(w, 'chunks', { motivation: 'highlighting' }, {}, LONG_TEXT);
    const resourceId = String(job.params.resourceId);
    w.ollama.script(
      // The first piece ends where the second paragraph does. Marker 205 is in the overlap, so the second piece sees it too.
      found(103, 205),
      found(205, 304),
      { response: JSON.stringify([{ exact: 'marker 502' }, { exact: 'marker 999 beside the Rhône was never recorded' }]) },
      found(),
    );
    const served = await w.start();
    const completion = await settled(served, job);

    expect(LONG_TEXT.length).toBe(3847);
    expectGenerations(
      w.ollama.generations,
      ['chunks-1', 'chunks-2', 'chunks-3', 'chunks-4'].map((name) => generation(agent.model, name, REQUEST, FORMATS.highlighting)),
    );
    expect(w.ollama.shows).toEqual([{ model: agent.model }]);

    // Each piece's spans are on the record, and its cursor said, before the next piece is asked for.
    expect(served.sequence()).toEqual([
      'emit job:claim',
      'emit job:start',
      'emit browse:resource-requested',
      `GET /resources/${resourceId}`,
      'emit mark:commit',
      'emit job:checkpoint',
      'emit mark:commit',
      'emit job:checkpoint',
      'emit mark:commit',
      'emit job:checkpoint',
      'emit job:checkpoint',
      'emit job:complete',
      'emit job:claim',
    ]);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [markerHighlight(w.generator(), resourceId, 'Odt5ohBuSHGwbCQ-QEybG', 103, 211), markerHighlight(w.generator(), resourceId, 'IILAtGKw8fjiHrcvYGCeC', 205, 852)],
      // Marker 205 was committed with the first piece: it is not committed again.
      [markerHighlight(w.generator(), resourceId, 'CM_HlyAOTLyS0O_23RZzq', 304, 1253)],
      [markerHighlight(w.generator(), resourceId, 'K3T1OrrNtETEnBM5baLBC', 502, 2055)],
    ]);

    // The cursor is where the next piece starts: the end of this one, less the overlap. The counts are the job's so far.
    const cursor = (next: number, found: number, emitted: number, errors: number) => ({
      jobId: job.metadata.id,
      completedUnits: [],
      unitCursors: { highlighting: { next, size: CHUNK_SIZE, found, emitted, errors } },
    });
    expect(served.payloads('job:checkpoint')).toEqual([cursor(704, 2, 2, 0), cursor(1666, 4, 3, 0), cursor(2628, 6, 4, 1), cursor(LONG_TEXT.length, 6, 4, 1)]);

    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing' }),
      // After each piece: what the job has made so far, and then how far through the text the next piece starts.
      report(job, 60, { code: 'creating-annotations', count: 2 }),
      report(job, 35, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 3 }),
      report(job, 43, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 4 }),
      report(job, 50, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 4 }),
      report(job, 100, { code: 'complete-created', count: 4, motivation: 'highlighting' }),
    ]);

    // Six proposed, the repeat among them; four recorded; one that is nowhere in the text.
    expect(completion).toEqual({ ...identity(job), result: { found: 6, persisted: 4, errors: 1 }, durability: 'acknowledged' });
  });
});
