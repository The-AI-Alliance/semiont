/**
 * A piece whose answer is cut off (WORKER-SERVICE.md § Failures): what it
 * carried is not used, the piece is asked again in halves, and the pieces
 * after it are cut smaller.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, LONG_TEXT, markerHighlight, markJob, report, settled, SMALL_CONTEXT_LENGTH, withoutCreated } from './support';

const found = (...markers: number[]) => ({ response: JSON.stringify(markers.map((n) => ({ exact: `marker ${n}` }))) });

eachWorkerService('a job whose model is cut off', (world) => {
  it('asks the piece again in halves, takes what the halves find together, and cuts the rest of the text at seven tenths the size', async () => {
    const w = world();
    const agent = w.agents[0]!;
    w.ollama.show = { contextLength: SMALL_CONTEXT_LENGTH };
    const job = markJob(w, 'halved', { motivation: 'highlighting' }, {}, LONG_TEXT);
    const resourceId = String(job.params.resourceId);
    w.ollama.script(
      // The first piece, of 311 tokens: the model runs out of room partway through its answer.
      { ...found(103), doneReason: 'length' },
      // The same text again in three pieces of at most 155 tokens.
      found(103),
      found(),
      found(205),
      // The rest of the text, in pieces of 217 tokens. Marker 205 and marker 304 are each seen twice.
      found(205, 304),
      found(304),
      found(),
      found(),
      found(),
      found(),
    );
    const served = await w.start();
    const completion = await settled(served, job);

    const asked = (name: string, num_ctx: number) => generation(agent.model, name, { num_predict: 622, num_ctx, temperature: 0 }, FORMATS.highlighting);
    expectGenerations(w.ollama.generations, [
      asked('chunks-1', SMALL_CONTEXT_LENGTH),
      asked('halved-half-1', 1151),
      asked('halved-half-2', 1180),
      asked('halved-half-3', 1132),
      ...[1, 2, 3, 4, 5, 6].map((n) => asked(`halved-rest-${n}`, SMALL_CONTEXT_LENGTH)),
    ]);

    // The halves are one piece to the job: one batch, and one cursor, which states the size the piece was first cut at.
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [markerHighlight(w.generator(), resourceId, 'W30xEEdxJok2bPhyoZdHL', 103, 211), markerHighlight(w.generator(), resourceId, 'fWhWTeophhJTzKBl4xDgP', 205, 852)],
      [markerHighlight(w.generator(), resourceId, 'S4STm5zK0eVKRpM67nFmp', 304, 1253)],
    ]);
    const cursor = (next: number, size: number, found: number, emitted: number) => ({ jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next, size, found, emitted, errors: 0 } } });
    expect(served.payloads('job:checkpoint')).toEqual([
      cursor(704, 311, 2, 2),
      cursor(1185, 217, 4, 3),
      cursor(1666, 217, 5, 3),
      cursor(2147, 217, 5, 3),
      cursor(2628, 217, 5, 3),
      cursor(3109, 217, 5, 3),
      cursor(LONG_TEXT.length, 217, 5, 3),
    ]);

    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 2 }),
      report(job, 35, { code: 'analyzing' }),
      ...[39, 43, 47, 50, 54].flatMap((percentage) => [report(job, 60, { code: 'creating-annotations', count: 3 }), report(job, percentage, { code: 'analyzing' })]),
      report(job, 60, { code: 'creating-annotations', count: 3 }),
      report(job, 100, { code: 'complete-created', count: 3, motivation: 'highlighting' }),
    ]);
    // What the cut-off answer carried is counted nowhere.
    expect(completion).toEqual({ ...identity(job), result: { found: 5, persisted: 3 }, durability: 'acknowledged' });
  });
});
