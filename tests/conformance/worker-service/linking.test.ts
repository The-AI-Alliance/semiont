/**
 * A `mark` job of motivation `linking`, end to end (WORKER-SERVICE.md
 * § Detection, § The five kinds of mark job): one unit for each entity type,
 * each an extraction and a count of the same text, committed and checkpointed
 * as it finishes.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, markJob, report, settled, TEXT, textAnnotation, withoutCreated } from './support';

const EXTRACTION = { num_predict: 5318, num_ctx: 5758, temperature: 0 };
const COUNT = { num_predict: 16, num_ctx: 244, temperature: 0 };
const CHUNK_SIZE = 2658;

/** An unresolved reference's body: the entity type, as a tag. */
const entity = (type: string) => [{ type: 'TextualBody', value: type, purpose: 'tagging', format: 'text/plain', language: 'en' }];

eachWorkerService('a linking job', (world) => {
  it('extracts and counts each entity type in turn, commits each type\'s references, and checkpoints each type as it finishes', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'linking', { motivation: 'linking', entityTypes: ['Person', 'Place'] });
    const resourceId = String(job.params.resourceId);
    w.ollama.script(
      { response: JSON.stringify([{ exact: 'Ada Lovelace', entityType: 'Person', prefix: '', suffix: ' published' }, { exact: 'Charles Babbage', entityType: 'Person' }]) },
      { response: '2' },
      {
        response: JSON.stringify([
          { exact: 'London', entityType: 'Place', prefix: 'engine in ', suffix: ', but' },
          { exact: 'London', entityType: 'Place', prefix: 'standards, and ', suffix: ' ignored' },
          { exact: 'London', entityType: 'Place', prefix: 'ignored it. ', suffix: ' was wrong' },
        ]),
      },
      { response: '3' },
    );
    const served = await w.start();
    const completion = await settled(served, job);

    // An Ollama model is asked one thing at a time: the types run in the order the job names them.
    expectGenerations(w.ollama.generations, [
      generation(agent.model, 'linking-person', EXTRACTION, FORMATS.linking),
      generation(agent.model, 'linking-person-count', COUNT),
      generation(agent.model, 'linking-place', EXTRACTION, FORMATS.linking),
      generation(agent.model, 'linking-place-count', COUNT),
    ]);

    expect(served.sequence()).toEqual([
      'emit job:claim',
      'emit job:start',
      'emit browse:resource-requested',
      `GET /resources/${resourceId}`,
      'emit mark:commit',
      'emit job:checkpoint',
      'emit job:checkpoint',
      'emit mark:commit',
      'emit job:checkpoint',
      'emit job:checkpoint',
      'emit job:complete',
      'emit job:claim',
    ]);

    expect(served.payloads('mark:commit').map((p) => ({ ...p, annotations: withoutCreated(p['annotations']) }))).toEqual([
      {
        resourceId,
        jobId: job.metadata.id,
        annotations: [
          textAnnotation(
            w.generator(),
            resourceId,
            'linking',
            '_qdCaMUODSin_sHZFtof7',
            { start: 0, end: 12, exact: 'Ada Lovelace', suffix: ' published the first program in 1843 — a method for computing Bernoulli' },
            entity('Person'),
          ),
          textAnnotation(
            w.generator(),
            resourceId,
            'linking',
            '89Jk8b_cyDcqcecXwQwaP',
            {
              start: 119,
              end: 134,
              exact: 'Charles Babbage',
              prefix: 'method for computing Bernoulli numbers on the Analytical Engine.\n\n',
              suffix: ' designed the engine in London, but it was never built. Lovelace',
            },
            entity('Person'),
          ),
        ],
      },
      {
        resourceId,
        jobId: job.metadata.id,
        annotations: [
          // The same six letters three times: three references, each where the model said it was.
          textAnnotation(
            w.generator(),
            resourceId,
            'linking',
            'OjagYqpBXoXouWpVXL3Jq',
            {
              start: 158,
              end: 164,
              exact: 'London',
              prefix: 'on the Analytical Engine.\n\nCharles Babbage designed the engine in ',
              suffix: ', but it was never built. Lovelace argued that the engine could manipulate',
            },
            entity('Place'),
          ),
          textAnnotation(
            w.generator(),
            resourceId,
            'linking',
            'AjMlDd0jqNBcBCAYUepkL',
            {
              start: 354,
              end: 360,
              exact: 'London',
              prefix: 'claim for a century.\n\nThe program was naïve by later standards, and ',
              suffix: ' ignored it. London was wrong.\n',
            },
            entity('Place'),
          ),
          textAnnotation(
            w.generator(),
            resourceId,
            'linking',
            '5Ub7ESqaglP5YEBeuDNBO',
            { start: 373, end: 379, exact: 'London', prefix: 'The program was naïve by later standards, and London ignored it. ', suffix: ' was wrong.\n' },
            entity('Place'),
          ),
        ],
      },
    ]);

    // A unit's cursor while it is partway, and the unit among the finished once its last batch is on the record.
    const cursor = (found: number) => ({ next: TEXT.length, size: CHUNK_SIZE, found, emitted: found, errors: 0 });
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Person: cursor(2) } },
      { jobId: job.metadata.id, completedUnits: ['Person'] },
      { jobId: job.metadata.id, completedUnits: ['Person'], unitCursors: { Place: cursor(3) } },
      { jobId: job.metadata.id, completedUnits: ['Person', 'Place'] },
    ]);

    const requestParams = [{ label: 'entity-types', value: 'Person, Place' }];
    const person = { value: 'Person', foundCount: 2, persistedCount: 2 };
    const place = { value: 'Place', foundCount: 3, persistedCount: 3 };
    /** A report of where the job stands while it works on `type`. */
    const standing = (percentage: number, type: string, processed: number, found: number, expected: number | undefined, emitted: number, completedItems: unknown[]) =>
      report(job, percentage, { code: 'detecting-entities', entityType: type }, {
        current: { kind: 'entity-type', value: type },
        processed,
        total: 2,
        entitiesFound: found,
        ...(expected === undefined ? {} : { entitiesExpected: expected }),
        entitiesEmitted: emitted,
        completedItems,
        requestParams,
      });
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }, { requestParams }),
      // Person: begun, counted, committed, finished.
      standing(20, 'Person', 0, 0, undefined, 0, []),
      standing(20, 'Person', 0, 0, 2, 0, []),
      standing(20, 'Person', 0, 2, 2, 2, []),
      standing(50, 'Person', 1, 2, 2, 2, [person]),
      // Place: the same four.
      standing(50, 'Place', 1, 2, 2, 2, [person]),
      standing(50, 'Place', 1, 2, 5, 2, [person]),
      standing(50, 'Place', 1, 5, 5, 5, [person]),
      standing(80, 'Place', 2, 5, 5, 5, [person, place]),
      report(job, 100, { code: 'complete-created', count: 5, motivation: 'linking' }, { entitiesExpected: 5, completedItems: [person, place], requestParams }),
    ]);

    expect(completion).toEqual({ ...identity(job), result: { found: 5, persisted: 5 }, durability: 'acknowledged' });
  });

  it('keeps what a piece too small to halve found, when the count says mentions were missed, and says so in its result and its reports', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'linking-under-reported', { motivation: 'linking', entityTypes: ['Place'] });
    w.ollama.script(
      { response: JSON.stringify([{ exact: 'London', entityType: 'Place', prefix: 'engine in ', suffix: ', but' }]) },
      // More than twice what the extraction found. The count is the first whole number in the answer.
      { response: 'There are 9 mentions, or 10.' },
    );
    const served = await w.start();
    const completion = await settled(served, job);

    // The text is one piece, so there is no half to ask for instead: asked once, and counted once.
    expectGenerations(w.ollama.generations, [generation(agent.model, 'linking-place', EXTRACTION, FORMATS.linking), generation(agent.model, 'linking-place-count', COUNT)]);
    expect(w.commits.map((c) => c.annotations.length)).toEqual([1]);

    const requestParams = [{ label: 'entity-types', value: 'Place' }];
    const place = { value: 'Place', foundCount: 1, persistedCount: 1, underReported: { pieces: 1, found: 1, counted: 9 } };
    const standing = (percentage: number, processed: number, found: number, expected: number | undefined, completedItems: unknown[]) =>
      report(job, percentage, { code: 'detecting-entities', entityType: 'Place' }, {
        current: { kind: 'entity-type', value: 'Place' },
        processed,
        total: 1,
        entitiesFound: found,
        ...(expected === undefined ? {} : { entitiesExpected: expected }),
        entitiesEmitted: found,
        completedItems,
        requestParams,
      });
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }, { requestParams }),
      standing(20, 0, 0, undefined, []),
      standing(20, 0, 0, 9, []),
      standing(20, 0, 1, 9, []),
      standing(80, 1, 1, 9, [place]),
      report(job, 100, { code: 'complete-created', count: 1, motivation: 'linking' }, { entitiesExpected: 9, completedItems: [place], requestParams }),
    ]);
    expect(completion).toEqual({ ...identity(job), result: { found: 1, persisted: 1, underReportedPieces: 1 }, durability: 'acknowledged' });
  });
});
