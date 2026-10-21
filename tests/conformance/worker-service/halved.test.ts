/**
 * A piece whose answer is cut off (WORKER-SERVICE.md § Failures): what it
 * carried is not used, the piece is asked again in halves, and the pieces
 * after it are cut smaller.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, LONG_TEXT, markerHighlight, markJob, report, settled, withoutCreated } from './support';

const found = (...markers: number[]) => ({ response: JSON.stringify(markers.map((n) => ({ exact: `marker ${n}` }))) });

/** A window at which `LONG_TEXT` is cut at 400 tokens, and its first piece, ended at a paragraph break, is three paragraphs. */
const WINDOW = 1467;

eachWorkerService('a job whose model is cut off', (world) => {
  it('asks the piece again in halves of its own size, takes what the halves find together, and cuts the rest of the text at seven tenths the size', async () => {
    const w = world();
    const agent = w.agents[0]!;
    w.ollama.show = { contextLength: WINDOW };
    const job = markJob(w, 'halved', { motivation: 'highlighting' }, {}, LONG_TEXT);
    const resourceId = String(job.params.resourceId);
    w.ollama.script(
      // The first piece, of 1441 code points, 361 tokens, though it was cut at 400: the model runs out of room partway through its answer.
      { ...found(103), doneReason: 'length' },
      // The same text again in four pieces of at most 180 tokens: half the piece's own 361, and not half the 400 it was cut at.
      found(103),
      found(205),
      found(),
      found(304),
      // The rest of the text, in pieces of 280 tokens. Marker 304 and marker 404 are each seen twice.
      found(304, 404),
      found(404),
      found(),
      found(),
      found(),
    );
    const served = await w.start();
    const completion = await settled(served, job);

    const asked = (name: string, num_ctx: number) => generation(agent.model, name, { num_predict: 800, num_ctx, temperature: 0 }, FORMATS.highlighting);
    expectGenerations(w.ollama.generations, [
      asked('halved-first', WINDOW),
      asked('halved-half-1', 1329),
      asked('halved-half-2', 1382),
      asked('halved-half-3', 1382),
      asked('halved-half-4', 1310),
      ...[1, 2, 3, 4, 5].map((n) => asked(`halved-rest-${n}`, 1406)),
    ]);

    // The halves are one piece to the job: one batch, and one cursor, which states the size the piece was first cut at.
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        markerHighlight(w.generator(), resourceId, 'W30xEEdxJok2bPhyoZdHL', 103, 211),
        markerHighlight(w.generator(), resourceId, 'fWhWTeophhJTzKBl4xDgP', 205, 852),
        markerHighlight(w.generator(), resourceId, 'S4STm5zK0eVKRpM67nFmp', 304, 1253),
      ],
      [markerHighlight(w.generator(), resourceId, '7cbv9AChTFxaDsfio0sPh', 404, 1734)],
    ]);
    const cursor = (next: number, size: number, found: number, emitted: number) => ({ jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next, size, found, emitted, errors: 0 } } });
    expect(served.payloads('job:checkpoint')).toEqual([
      cursor(1185, 400, 3, 3),
      cursor(1666, 280, 5, 4),
      cursor(2147, 280, 6, 4),
      cursor(2628, 280, 6, 4),
      cursor(3109, 280, 6, 4),
      cursor(LONG_TEXT.length, 280, 6, 4),
    ]);

    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 3 }),
      report(job, 39, { code: 'analyzing' }),
      ...[43, 47, 50, 54].flatMap((percentage) => [report(job, 60, { code: 'creating-annotations', count: 4 }), report(job, percentage, { code: 'analyzing' })]),
      report(job, 60, { code: 'creating-annotations', count: 4 }),
      report(job, 100, { code: 'complete-created', count: 4, motivation: 'highlighting' }),
    ]);
    // What the cut-off answer carried is counted nowhere.
    expect(completion).toEqual({ ...identity(job), result: { found: 6, persisted: 4 }, durability: 'acknowledged' });
  });
});
