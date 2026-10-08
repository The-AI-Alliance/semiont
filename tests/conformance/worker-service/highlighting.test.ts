/**
 * A `mark` job of motivation `highlighting`, end to end (WORKER-SERVICE.md
 * § What a job reads, § Detection, § The five kinds of mark job): what it reads,
 * the one request it makes of its model, the annotations it commits, what it
 * reports as it goes, and its completion.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, markJob, report, settled, TEXT, textAnnotation, withoutCreated } from './support';

const REQUEST = { num_predict: 5284, num_ctx: 5785, temperature: 0 };
/** The size, in tokens, the job cuts its text at: what its unit's cursor states. */
const CHUNK_SIZE = 2641;

eachWorkerService('a highlighting job', (world) => {
  it('reads the resource, asks its model once, commits the spans it can anchor, and completes with its counts', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'highlighting', { motivation: 'highlighting' });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({
      response: JSON.stringify([
        { exact: 'the first program', prefix: 'Ada Lovelace published ', suffix: ' in 1843' },
        // Three times in the text: what the model says is around it tells which.
        { exact: 'London', prefix: 'standards, and ', suffix: ' ignored it' },
        // Nowhere in the text.
        { exact: 'a steam locomotive crossing the Alps' },
      ]),
    });
    const served = await w.start();
    const completion = await settled(served, job);

    // What it asked the gateway for, in order. The job's description is read on the bus, its bytes over HTTP.
    expect(served.sequence()).toEqual([
      'emit job:claim',
      'emit job:start',
      'emit browse:resource-requested',
      `GET /resources/${resourceId}`,
      'emit mark:commit',
      'emit job:checkpoint',
      'emit job:complete',
      'emit job:claim',
    ]);
    expect(served.payloads('job:start')).toEqual([identity(job)]);
    expect(served.payloads('browse:resource-requested')).toEqual([{ resourceId }]);
    expect(w.anchoredTextReads).toEqual([]);

    // What it asked its model: its limits once, and one generation over the whole text.
    expect(w.ollama.shows).toEqual([{ model: agent.model }]);
    expectGenerations(w.ollama.generations, [generation(agent.model, 'highlighting', REQUEST, FORMATS.highlighting)]);

    // What it committed: one batch, for the job, of the two spans that are in the text.
    expect(served.payloads('mark:commit').map((p) => ({ ...p, annotations: withoutCreated(p['annotations']) }))).toEqual([
      {
        resourceId,
        jobId: job.metadata.id,
        annotations: [
          textAnnotation(w.generator(), resourceId, 'highlighting', 'L44bEdl-gy0zz0oZ4FIbs', {
            start: 23,
            end: 40,
            exact: 'the first program',
            prefix: 'Ada Lovelace published ',
            suffix: ' in 1843 — a method for computing Bernoulli numbers on the Analytical',
          }),
          textAnnotation(w.generator(), resourceId, 'highlighting', 'KMvMOmT6HejPBEUDVZpfV', {
            start: 354,
            end: 360,
            exact: 'London',
            prefix: 'claim for a century.\n\nThe program was naïve by later standards, and ',
            suffix: ' ignored it. London was wrong.\n',
          }),
        ],
      },
    ]);
    expect(w.commits.map((c) => c.by)).toEqual([agent.did]);
    expect(TEXT.slice(354, 360)).toBe('London');

    // Where that leaves its one unit, said once the batch is on the record.
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next: TEXT.length, size: CHUNK_SIZE, found: 3, emitted: 2, errors: 1 } } },
    ]);

    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 2 }),
      report(job, 100, { code: 'complete-created', count: 2, motivation: 'highlighting' }),
    ]);

    // Three proposed, two recorded, one that could not be anchored.
    expect(completion).toEqual({ ...identity(job), result: { found: 3, persisted: 2, errors: 1 }, durability: 'acknowledged' });
  });

  it('commits nothing when its model finds nothing, and says so in its counts', async () => {
    const w = world();
    const job = markJob(w, 'highlighting-none', { motivation: 'highlighting' });
    w.ollama.script({ response: '[]' });
    const served = await w.start();
    const completion = await settled(served, job);

    expect(served.sequence()).toEqual([
      'emit job:claim',
      'emit job:start',
      'emit browse:resource-requested',
      `GET /resources/${String(job.params.resourceId)}`,
      'emit job:checkpoint',
      'emit job:complete',
      'emit job:claim',
    ]);
    expect(w.commits).toEqual([]);
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next: TEXT.length, size: CHUNK_SIZE, found: 0, emitted: 0, errors: 0 } } },
    ]);
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 0 }),
      report(job, 100, { code: 'complete-created', count: 0, motivation: 'highlighting' }),
    ]);
    // A job that committed nothing says nothing of how its commits were established.
    expect(completion).toEqual({ ...identity(job), result: { found: 0, persisted: 0 } });
  });

  it('asks as its instructions, density and source language say', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'highlighting-instructed', { motivation: 'highlighting', instructions: 'Highlight every date.', density: 2, sourceLanguage: 'en' });
    w.ollama.script({ response: JSON.stringify([{ exact: '1843' }]) });
    const served = await w.start();
    const completion = await settled(served, job);

    expectGenerations(w.ollama.generations, [generation(agent.model, 'highlighting-instructed', { num_predict: 5352, num_ctx: 5731, temperature: 0 }, FORMATS.highlighting)]);
    // What the job was asked with is echoed on every report.
    const asked = { requestParams: [{ label: 'instructions', value: 'Highlight every date.' }, { label: 'density', value: '2' }] };
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }, asked),
      report(job, 30, { code: 'analyzing' }, asked),
      report(job, 60, { code: 'creating-annotations', count: 1 }, asked),
      report(job, 100, { code: 'complete-created', count: 1, motivation: 'highlighting' }, asked),
    ]);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(w.generator(), String(job.params.resourceId), 'highlighting', 'RcaAxfiOERnhmMQjc71iR', {
          start: 44,
          end: 48,
          exact: '1843',
          prefix: 'Ada Lovelace published the first program in ',
          suffix: ' \u2014 a method for computing Bernoulli numbers on the Analytical Engine',
        }),
      ],
    ]);
    expect(completion).toEqual({ ...identity(job), result: { found: 1, persisted: 1 }, durability: 'acknowledged' });
  });
});
