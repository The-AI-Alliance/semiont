/**
 * A cancellation of the job a worker holds (WORKER-SERVICE.md
 * § Cancellation): every job stops at its next stopping place, a `mark` job
 * after the piece it is on and a `yield` job before it uploads; it says
 * `job:cancel` with the units it finished, and reports no completion.
 *
 * A cancellation does not end a generation that is under way. So most cases
 * here hold the provider's answer, ask for the cancellation, wait until the
 * worker has had it, and only then let the provider answer: what the worker
 * does next is what it does with a cancellation in hand.
 */
import { expect, it } from 'vitest';
import { errorsOf, spec } from '../harness/spec';
import { eachWorkerService, type RunningJob, type WorkerServiceWorld } from '../harness/worker-service-world';
import { cancelRequested, expectProgress, identity, LONG_TEXT, markerHighlight, markJob, report, settled, SMALL_CONTEXT_LENGTH, TEXT, textAnnotation, withoutCreated } from './support';

/** A schema of two categories, as the dispatcher adds it to a tagging job. */
const SCHEMA = {
  id: 'argument',
  name: 'Argument',
  description: 'What a text claims and what it offers in support',
  domain: 'rhetoric',
  tags: [
    { name: 'Claim', description: 'What the text asserts', examples: ['What is being asserted?'] },
    { name: 'Evidence', description: 'What supports the assertion', examples: ['What supports it?', 'Is a source given?'] },
  ],
};

const SOURCE = 'res-ws-cancel-source';
const SOURCE_DESCRIPTOR = {
  '@context': 'https://schema.org',
  '@id': SOURCE,
  name: 'Notes on the engine',
  representations: [{ mediaType: 'text/markdown', storageUri: `file://worker-service/${SOURCE}`, rel: 'original' }],
};

/** A `yield` job focused on a resource, queued. */
function yieldJob(w: WorkerServiceWorld, name: string): RunningJob {
  const params = {
    resourceId: SOURCE,
    title: 'The Analytical Engine',
    storageUri: `file://generated/${name}.md`,
    context: { focus: { kind: 'resource', resource: SOURCE_DESCRIPTOR, content: { main: TEXT, related: {} } }, graph: { nodes: [], edges: [] }, metadata: {} },
  };
  const validate = spec().component('GenerationJobParams');
  expect(validate(params), errorsOf(validate)).toBe(true);
  return w.queued(`job-ws-${name}`, 'yield', params);
}

/**
 * What a `mark` job that stopped after one piece asked of the gateway, in
 * order: its one batch, its checkpoints, and its cancel. `held` is a case that
 * held the provider's answer until the worker had the cancellation: the
 * worker's answer to the request that told the case so falls there.
 */
const stoppedAfterOnePiece = (resourceId: string, checkpoints: number, held = true): string[] => [
  'emit job:claim',
  'emit job:start',
  'emit browse:resource-requested',
  `GET /resources/${resourceId}`,
  ...(held ? ['emit job:limits-result'] : []),
  'emit mark:commit',
  ...Array.from({ length: checkpoints }, () => 'emit job:checkpoint'),
  'emit job:cancel',
  'emit job:claim',
];

/** An unresolved reference's body: the entity type, as a tag. */
const entity = (type: string) => [{ type: 'TextualBody', value: type, purpose: 'tagging', format: 'text/plain', language: 'en' }];

eachWorkerService('a job that is cancelled', (world) => {
  it('stops a highlighting job after the piece it is on: that piece is committed and checkpointed, no other is asked about, and no completion is reported', async () => {
    const w = world();
    w.ollama.show = { contextLength: SMALL_CONTEXT_LENGTH };
    const job = markJob(w, 'cancel-highlighting', { motivation: 'highlighting' }, {}, LONG_TEXT);
    const resourceId = String(job.params.resourceId);
    // The text is four pieces. The first is held with the model while the cancellation arrives.
    w.ollama.script({ hold: true });
    const served = await w.start();
    await w.ollama.asked(1);
    await cancelRequested(w, job);
    // The cancellation did not end the request: the worker still waits on it, and has said nothing of the job since.
    expect(w.ollama.generations[0]!.abandoned).toBe(false);
    expect(served.emits('job:cancel')).toEqual([]);
    w.ollama.release({ response: JSON.stringify([{ exact: 'marker 103' }, { exact: 'marker 205' }]) });
    const cancel = await settled(served, job, 'job:cancel');

    // One generation: the second piece was never asked about.
    expect(w.ollama.generations).toHaveLength(1);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [markerHighlight(w.generator(), resourceId, 'VetijqYBmNe9ReSC41dJL', 103, 211), markerHighlight(w.generator(), resourceId, 'WKYaFWYQ1X6WqqdM94o2-', 205, 852)],
    ]);
    expect(served.payloads('job:checkpoint')).toEqual([{ jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next: 704, size: 311, found: 2, emitted: 2, errors: 0 } } }]);
    expect(served.sequence()).toEqual(stoppedAfterOnePiece(resourceId, 1));
    // It was partway through its one unit: the cancel names none, and states no attempt.
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark' });
    // What the piece made is reported; where the next piece would start, and a completion, are not.
    expectProgress(served, job, [report(job, 10, { code: 'loading' }), report(job, 30, { code: 'analyzing' }), report(job, 60, { code: 'creating-annotations', count: 2 })]);
    expect(served.emits('job:complete')).toEqual([]);
    expect(served.emits('job:fail')).toEqual([]);
  });

  it('stops a commenting job after the piece it is on', async () => {
    const w = world();
    w.ollama.show = { contextLength: SMALL_CONTEXT_LENGTH };
    const job = markJob(w, 'cancel-commenting', { motivation: 'commenting' }, {}, LONG_TEXT);
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ hold: true });
    const served = await w.start();
    await w.ollama.asked(1);
    await cancelRequested(w, job);
    w.ollama.release({ response: JSON.stringify([{ exact: 'marker 103', comment: 'The third marker of the first paragraph.' }]) });
    const cancel = await settled(served, job, 'job:cancel');

    expect(w.ollama.generations).toHaveLength(1);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(
          w.generator(),
          resourceId,
          'commenting',
          'C16Xzw7e77tX-n7CHJ4ey',
          {
            start: 211,
            end: 221,
            exact: 'marker 103',
            prefix: 'beside the Rhône. Paragraph 1, sentence 3: the survey party recorded ',
            suffix: ' beside the Rhône. Paragraph 1, sentence 4: the survey party recorded',
          },
          [{ type: 'TextualBody', value: 'The third marker of the first paragraph.', purpose: 'commenting', format: 'text/plain', language: 'en' }],
        ),
      ],
    ]);
    expect(served.payloads('job:checkpoint')).toEqual([{ jobId: job.metadata.id, completedUnits: [], unitCursors: { commenting: { next: 704, size: 292, found: 1, emitted: 1, errors: 0 } } }]);
    expect(served.sequence()).toEqual(stoppedAfterOnePiece(resourceId, 1));
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark' });
    expectProgress(served, job, [report(job, 10, { code: 'loading' }), report(job, 30, { code: 'analyzing' }), report(job, 60, { code: 'creating-annotations', count: 1 })]);
    expect(served.emits('job:complete')).toEqual([]);
  });

  it('stops a tagging job partway through its categories: the category it is on is finished and named, and the next is never asked about', async () => {
    const w = world();
    const job = markJob(w, 'cancel-tagging', { motivation: 'tagging', schemaId: SCHEMA.id, categories: ['Claim', 'Evidence'], schema: SCHEMA });
    const resourceId = String(job.params.resourceId);
    // The text is one piece for each category. The first category's is held with the model.
    w.ollama.script({ hold: true });
    const served = await w.start();
    await w.ollama.asked(1);
    await cancelRequested(w, job);
    w.ollama.release({ response: JSON.stringify([{ exact: 'London was wrong.' }]) });
    const cancel = await settled(served, job, 'job:cancel');

    expect(w.ollama.generations).toHaveLength(1);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(
          w.generator(),
          resourceId,
          'tagging',
          'uQhBVKeO0xajjHhBxV3fv',
          { start: 373, end: 390, exact: 'London was wrong.', prefix: 'The program was naïve by later standards, and London ignored it. ', suffix: '\n' },
          [
            { type: 'TextualBody', value: 'Claim', purpose: 'tagging', format: 'text/plain', language: 'en' },
            { type: 'TextualBody', value: 'argument', purpose: 'classifying', format: 'text/plain' },
          ],
        ),
      ],
    ]);
    expect(served.payloads('job:checkpoint')).toEqual([{ jobId: job.metadata.id, completedUnits: [], unitCursors: { Claim: { next: TEXT.length, size: 2621, found: 1, emitted: 1, errors: 0 } } }]);
    expect(served.sequence()).toEqual(stoppedAfterOnePiece(resourceId, 1));
    // The category it finished is named; the one it never began is not.
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark', completedUnits: ['Claim'] });
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing-tags' }),
      report(job, 30, { code: 'analyzing-tags' }, { current: { kind: 'category', value: 'Claim' }, processed: 0, total: 2, completedItems: [] }),
      report(job, 60, { code: 'creating-tag-annotations', count: 1 }),
    ]);
    expect(served.emits('job:complete')).toEqual([]);
  });

  it('stops a linking job partway through an entity type of several pieces: after the piece, with the type not named as finished', async () => {
    const w = world();
    w.ollama.show = { contextLength: SMALL_CONTEXT_LENGTH };
    const job = markJob(w, 'cancel-linking-partway', { motivation: 'linking', entityTypes: ['Person', 'Place'] }, {}, LONG_TEXT);
    const resourceId = String(job.params.resourceId);
    // The text is four pieces for each type. The first piece's extraction is held with the model; its count is answered when asked.
    w.ollama.script({ hold: true }, { response: '1' });
    const served = await w.start();
    await w.ollama.asked(1);
    await cancelRequested(w, job);
    w.ollama.release({ response: JSON.stringify([{ exact: 'marker 103', entityType: 'Person' }]) });
    const cancel = await settled(served, job, 'job:cancel');

    // The piece's two generations, its extraction and its count, and no more: not the type's next piece, and not the next type.
    expect(w.ollama.generations).toHaveLength(2);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(
          w.generator(),
          resourceId,
          'linking',
          'UiVoMJKkMBGb-pq3TP5e1',
          {
            start: 211,
            end: 221,
            exact: 'marker 103',
            prefix: 'beside the Rhône. Paragraph 1, sentence 3: the survey party recorded ',
            suffix: ' beside the Rhône. Paragraph 1, sentence 4: the survey party recorded',
          },
          entity('Person'),
        ),
      ],
    ]);
    // The type is partway: its cursor is said, and it is not among the finished.
    expect(served.payloads('job:checkpoint')).toEqual([{ jobId: job.metadata.id, completedUnits: [], unitCursors: { Person: { next: 704, size: 328, found: 1, emitted: 1, errors: 0 } } }]);
    expect(served.sequence()).toEqual(stoppedAfterOnePiece(resourceId, 1));
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark' });

    const requestParams = [{ label: 'entity-types', value: 'Person, Place' }];
    const standing = (expected: number | undefined) =>
      report(job, 20, { code: 'detecting-entities', entityType: 'Person' }, {
        current: { kind: 'entity-type', value: 'Person' },
        processed: 0,
        total: 2,
        entitiesFound: 0,
        ...(expected === undefined ? {} : { entitiesExpected: expected }),
        entitiesEmitted: 0,
        completedItems: [],
        requestParams,
      });
    // The type begun, and its mentions counted: both said while the piece was being asked about. Nothing after its checkpoint.
    expectProgress(served, job, [report(job, 10, { code: 'loading' }, { requestParams }), standing(undefined), standing(1)]);
    expect(served.emits('job:complete')).toEqual([]);
  });

  it('settles as cancelled a linking job cancelled on the last piece of its last entity type, with every type named', async () => {
    const w = world();
    const job = markJob(w, 'cancel-linking-last', { motivation: 'linking', entityTypes: ['Person'] });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ hold: true }, { response: '1' });
    const served = await w.start();
    await w.ollama.asked(1);
    await cancelRequested(w, job);
    w.ollama.release({ response: JSON.stringify([{ exact: 'Ada Lovelace', entityType: 'Person' }]) });
    const cancel = await settled(served, job, 'job:cancel');

    expect(w.ollama.generations).toHaveLength(2);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(
          w.generator(),
          resourceId,
          'linking',
          'fmelsDjChhC9dkXYrCyEE',
          { start: 0, end: 12, exact: 'Ada Lovelace', suffix: ' published the first program in 1843 — a method for computing Bernoulli' },
          entity('Person'),
        ),
      ],
    ]);
    // The piece was the type's last: its cursor is said, and then the type among the finished, as for any type.
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Person: { next: TEXT.length, size: 2658, found: 1, emitted: 1, errors: 0 } } },
      { jobId: job.metadata.id, completedUnits: ['Person'] },
    ]);
    expect(served.sequence()).toEqual(stoppedAfterOnePiece(resourceId, 2));
    // Nothing was left to do but settle, and it is settled as cancelled all the same.
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark', completedUnits: ['Person'] });
    expect(served.progress(job.metadata.id).filter((p) => (p['progress'] as { message: { code: string } }).message.code === 'complete-created')).toEqual([]);
    expect(served.emits('job:complete')).toEqual([]);
  });

  it('stops a linking job between entity types when the cancellation arrives as a type\'s last batch is committed', async () => {
    const w = world();
    const job = markJob(w, 'cancel', { motivation: 'linking', entityTypes: ['Person', 'Place'] });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ response: JSON.stringify([{ exact: 'Ada Lovelace', entityType: 'Person' }]) }, { response: '1' });
    // The cancellation is asked for while the first type's batch is being committed, before the record acknowledges it.
    let asked = false;
    w.hooks.commit = async () => {
      if (!asked) {
        asked = true;
        await w.emit('job:cancel-requested', { jobId: job.metadata.id });
      }
      return undefined;
    };
    const served = await w.start();
    const cancel = await settled(served, job, 'job:cancel');

    // The second type was never asked for.
    expect(w.ollama.generations).toHaveLength(2);
    // What the first type found is on the record, and the type is checkpointed as finished.
    expect(w.commits.map((c) => c.annotations.length)).toEqual([1]);
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Person: { next: TEXT.length, size: 2658, found: 1, emitted: 1, errors: 0 } } },
      { jobId: job.metadata.id, completedUnits: ['Person'] },
    ]);
    expect(served.sequence()).toEqual(stoppedAfterOnePiece(resourceId, 2, false));
    // A cancel names the job and what it finished, and states no attempt.
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark', completedUnits: ['Person'] });
    expect(served.progress(job.metadata.id).filter((p) => (p['progress'] as { message: { code: string } }).message.code === 'complete-created')).toEqual([]);
    expect(served.emits('job:complete')).toEqual([]);
    expect(served.emits('job:fail')).toEqual([]);
  });

  it('settles as cancelled a highlighting job cancelled on its only piece, with its one unit named', async () => {
    const w = world();
    const job = markJob(w, 'cancel-highlighting-last', { motivation: 'highlighting' });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ hold: true });
    const served = await w.start();
    await w.ollama.asked(1);
    await cancelRequested(w, job);
    w.ollama.release({ response: JSON.stringify([{ exact: 'the first program' }]) });
    const cancel = await settled(served, job, 'job:cancel');

    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(w.generator(), resourceId, 'highlighting', 'luRRYETclpP6f4x3jG5pZ', {
          start: 23,
          end: 40,
          exact: 'the first program',
          prefix: 'Ada Lovelace published ',
          suffix: ' in 1843 — a method for computing Bernoulli numbers on the Analytical',
        }),
      ],
    ]);
    expect(served.payloads('job:checkpoint')).toEqual([{ jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next: TEXT.length, size: 2641, found: 1, emitted: 1, errors: 0 } } }]);
    expect(served.sequence()).toEqual(stoppedAfterOnePiece(resourceId, 1));
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark', completedUnits: ['highlighting'] });
    expectProgress(served, job, [report(job, 10, { code: 'loading' }), report(job, 30, { code: 'analyzing' }), report(job, 60, { code: 'creating-annotations', count: 1 })]);
    expect(served.emits('job:complete')).toEqual([]);
  });

  it('asks its model nothing, and reports nothing, for a mark job cancelled before its first piece', async () => {
    const w = world();
    const job = markJob(w, 'cancel-before', { motivation: 'highlighting' });
    const resourceId = String(job.params.resourceId);
    // The cancellation is asked for while the job reads its resource's description, before that is answered.
    w.hooks.described = async () => {
      await w.emit('job:cancel-requested', { jobId: job.metadata.id });
    };
    const served = await w.start();
    const cancel = await settled(served, job, 'job:cancel');

    expect(w.ollama.shows).toEqual([]);
    expect(w.ollama.generations).toEqual([]);
    expect(w.commits).toEqual([]);
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'emit browse:resource-requested', `GET /resources/${resourceId}`, 'emit job:cancel', 'emit job:claim']);
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark' });
    expectProgress(served, job, []);
  });

  it('stops a yield job before it uploads, when the cancellation has arrived by the time its model has answered', async () => {
    const w = world();
    const job = yieldJob(w, 'cancel-yield');
    w.ollama.script({ hold: true });
    const served = await w.start();
    await w.ollama.asked(1);
    await cancelRequested(w, job);
    expect(w.ollama.generations[0]!.abandoned).toBe(false);
    w.ollama.release({ response: 'The engine was designed in London and never built.' });
    const cancel = await settled(served, job, 'job:cancel');

    // Nothing reached the gateway but the job's own lifecycle: no upload, and no commit.
    expect(w.ollama.generations).toHaveLength(1);
    expect(w.world.archivist.uploads).toEqual([]);
    expect(w.commits).toEqual([]);
    // (The limits it answered are the request that told this case the cancellation had arrived.)
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'emit job:limits-result', 'emit job:cancel', 'emit job:claim']);
    expect(cancel).toEqual({ resourceId: SOURCE, jobId: job.metadata.id, jobType: 'yield' });
    // It said it was generating, and nothing after its model answered.
    expectProgress(served, job, [report(job, 5, { code: 'generating-resource' })]);
    expect(served.emits('job:complete')).toEqual([]);
    expect(served.emits('job:fail')).toEqual([]);
  });

  it('runs a yield job to its end when the cancellation arrives after its upload', async () => {
    const w = world();
    const job = yieldJob(w, 'cancel-yield-late');
    w.ollama.script({ response: 'The engine was designed in London and never built.' });
    // The cancellation is asked for while the link from the source is being committed: the upload has been sent.
    w.hooks.commit = async () => {
      await w.emit('job:cancel-requested', { jobId: job.metadata.id });
      return undefined;
    };
    const served = await w.start();
    const completion = await settled(served, job);

    expect(w.world.archivist.uploads).toHaveLength(1);
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'POST /resources', 'emit mark:commit', 'emit job:complete', 'emit job:claim']);
    expect(completion).toEqual({ ...identity(job), result: { resourceId: w.world.archivist.uploads[0]!.resourceId, resourceName: 'The Analytical Engine', truncated: false }, durability: 'acknowledged' });
    expect(served.emits('job:cancel')).toEqual([]);
    expectProgress(served, job, [report(job, 5, { code: 'generating-resource' }), report(job, 95, { code: 'creating-resource' }), report(job, 100, { code: 'complete-generated', truncated: false })]);
  });
});
