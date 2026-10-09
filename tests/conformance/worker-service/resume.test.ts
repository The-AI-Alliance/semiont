/**
 * A job resumed from the checkpoint an earlier attempt left
 * (WORKER-SERVICE.md § Resuming): a unit partway is taken up at its cursor, a
 * finished unit is not done again and is counted by its cursor, and nothing
 * is committed twice.
 */
import { expect, it } from 'vitest';
import { eachWorkerService, type RunningJob } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, LONG_TEXT, markerHighlight, markJob, report, settled, SMALL_CONTEXT_LENGTH, TEXT, textAnnotation, withoutCreated } from './support';

const found = (...markers: number[]) => ({ response: JSON.stringify(markers.map((n) => ({ exact: `marker ${n}` }))) });

const EXTRACTION = { num_predict: 5318, num_ctx: 5758, temperature: 0 };
const COUNT = { num_predict: 16, num_ctx: 244, temperature: 0 };
/** The size, in tokens, a linking job cuts the short text at. */
const LINKING_SIZE = 2658;

/** The entity types of the linking jobs here, as every report of one repeats them. */
const TYPES = [{ label: 'entity-types', value: 'Person, Place' }];

/** A report of where a linking job of Person and Place stands while it works on Place. */
const onPlace = (job: RunningJob, percentage: number, processed: number, found: number, expected: number | undefined, emitted: number, completedItems: unknown[]) =>
  report(job, percentage, { code: 'detecting-entities', entityType: 'Place' }, {
    current: { kind: 'entity-type', value: 'Place' },
    processed,
    total: 2,
    entitiesFound: found,
    ...(expected === undefined ? {} : { entitiesExpected: expected }),
    entitiesEmitted: emitted,
    completedItems,
    requestParams: TYPES,
  });

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

eachWorkerService('a job resumed from a checkpoint', (world) => {
  it('takes a unit up at its cursor, with a smaller piece, and reports counts that include what the earlier attempt made', async () => {
    const w = world();
    const agent = w.agents[0]!;
    w.ollama.show = { contextLength: SMALL_CONTEXT_LENGTH };
    // The earlier attempt got through two pieces of 311 tokens: four proposed, three recorded.
    const job = markJob(
      w,
      'resume',
      { motivation: 'highlighting' },
      { retryCount: 1, unitCursors: { highlighting: { next: 1666, size: 311, found: 4, emitted: 3, errors: 0 } } },
      LONG_TEXT,
    );
    const resourceId = String(job.params.resourceId);
    w.ollama.script(found(502), found(), found(701), found());
    const served = await w.start();
    const completion = await settled(served, job);

    // It says which attempt this is.
    expect(served.payloads('job:start')).toEqual([{ ...identity(job), attempt: 2 }]);

    // Nothing before the cursor is asked for again, and the pieces are smaller than the attempt that died cut them: seven tenths the size.
    expectGenerations(
      w.ollama.generations,
      ['resume-1', 'resume-2', 'resume-3', 'resume-4'].map((name) => generation(agent.model, name, { num_predict: 622, num_ctx: SMALL_CONTEXT_LENGTH, temperature: 0 }, FORMATS.highlighting)),
    );
    for (const asked of w.ollama.generations) expect(String(asked.body['prompt'])).not.toContain('marker 205');

    // Nothing the earlier attempt committed is committed again.
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [markerHighlight(w.generator(), resourceId, 'kt2ObciadyGT8niATrisW', 502, 2055)],
      [markerHighlight(w.generator(), resourceId, 'FfDja00V2TxfmuDTppb2d', 701, 2937)],
    ]);

    const cursor = (next: number, found: number, emitted: number) => ({ jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next, size: 217, found, emitted, errors: 0 } } });
    expect(served.payloads('job:checkpoint')).toEqual([cursor(2147, 5, 4), cursor(2628, 5, 4), cursor(3109, 6, 5), cursor(LONG_TEXT.length, 6, 5)]);

    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 4 }),
      report(job, 47, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 4 }),
      report(job, 50, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 5 }),
      report(job, 54, { code: 'analyzing' }),
      report(job, 60, { code: 'creating-annotations', count: 5 }),
      report(job, 100, { code: 'complete-created', count: 5, motivation: 'highlighting' }),
    ]);

    // The counts are the whole text's: the earlier attempt's four and three, and this one's two.
    expect(completion).toEqual({ ...identity(job), attempt: 2, result: { found: 6, persisted: 5 }, durability: 'acknowledged' });
  });

  it('does not do again an entity type an earlier attempt finished, and counts nothing for one the record holds no cursor for', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'resume-units', { motivation: 'linking', entityTypes: ['Person', 'Place'] }, { retryCount: 2, completedUnits: ['Person'] });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ response: JSON.stringify([{ exact: 'London', entityType: 'Place', prefix: 'engine in ', suffix: ', but' }]) }, { response: '1' });
    const served = await w.start();
    const completion = await settled(served, job);

    expect(served.payloads('job:start')).toEqual([{ ...identity(job), attempt: 3 }]);
    // Only the unfinished type is asked for: its extraction, and its count.
    expectGenerations(w.ollama.generations, [generation(agent.model, 'linking-place', EXTRACTION, FORMATS.linking), generation(agent.model, 'linking-place-count', COUNT)]);
    const commits = served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']));
    expect(commits).toHaveLength(1);
    expect(commits[0]!.map((a) => (a['body'] as Array<{ value: string }>)[0]!.value)).toEqual(['Place']);
    expect((commits[0]![0]!['target'] as { source: string; selector: Array<Record<string, unknown>> }).selector[0]).toEqual({ type: 'TextPositionSelector', start: 158, end: 164 });
    expect(TEXT.slice(158, 164)).toBe('London');
    expect(resourceId).toBe('res-ws-resume-units');

    // The type this attempt finishes is named, with its cursor. The other is on the record already, and the job was claimed with no cursor for it.
    const place = { next: TEXT.length, size: LINKING_SIZE, found: 1, emitted: 1, errors: 0 };
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Place: place } },
      { jobId: job.metadata.id, completedUnits: ['Place'], unitCursors: { Place: place } },
    ]);

    // Both types are the job's, and one of them is finished from the first report. Nothing says what it found: it is not listed, and adds nothing.
    const placeItem = { value: 'Place', foundCount: 1, persistedCount: 1 };
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }, { requestParams: TYPES }),
      onPlace(job, 50, 1, 0, undefined, 0, []),
      onPlace(job, 50, 1, 0, 1, 0, []),
      onPlace(job, 50, 1, 1, 1, 1, []),
      onPlace(job, 80, 2, 1, 1, 1, [placeItem]),
      report(job, 100, { code: 'complete-created', count: 1, motivation: 'linking' }, { entitiesExpected: 1, completedItems: [placeItem], requestParams: TYPES }),
    ]);
    expect(completion).toEqual({ ...identity(job), attempt: 3, result: { found: 1, persisted: 1 }, durability: 'acknowledged' });
  });

  it('counts an entity type an earlier attempt finished by the cursor it ended at: the result and every report are of both types', async () => {
    const w = world();
    const agent = w.agents[0]!;
    // The earlier attempt finished Person: three proposed, two recorded, one that made nothing. Its cursor is where it ended.
    const person = { next: TEXT.length, size: LINKING_SIZE, found: 3, emitted: 2, errors: 1 };
    const job = markJob(w, 'resume-counts', { motivation: 'linking', entityTypes: ['Person', 'Place'] }, { retryCount: 1, completedUnits: ['Person'], unitCursors: { Person: person } });
    const resourceId = String(job.params.resourceId);
    w.ollama.script(
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

    expect(served.payloads('job:start')).toEqual([{ ...identity(job), attempt: 2 }]);
    // The finished type is not asked about again.
    expectGenerations(w.ollama.generations, [generation(agent.model, 'linking-place', EXTRACTION, FORMATS.linking), generation(agent.model, 'linking-place-count', COUNT)]);

    const reference = [{ type: 'TextualBody', value: 'Place', purpose: 'tagging', format: 'text/plain', language: 'en' }];
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(
          w.generator(),
          resourceId,
          'linking',
          'T2TKs0Jg-PQWeqox5fGnh',
          {
            start: 158,
            end: 164,
            exact: 'London',
            prefix: 'on the Analytical Engine.\n\nCharles Babbage designed the engine in ',
            suffix: ', but it was never built. Lovelace argued that the engine could manipulate',
          },
          reference,
        ),
        textAnnotation(
          w.generator(),
          resourceId,
          'linking',
          'Xkpj1ubZZRS5i6pmLeXW0',
          {
            start: 354,
            end: 360,
            exact: 'London',
            prefix: 'claim for a century.\n\nThe program was naïve by later standards, and ',
            suffix: ' ignored it. London was wrong.\n',
          },
          reference,
        ),
        textAnnotation(
          w.generator(),
          resourceId,
          'linking',
          'MuYzJyXJorvNj5mhK1Ryw',
          { start: 373, end: 379, exact: 'London', prefix: 'The program was naïve by later standards, and London ignored it. ', suffix: ' was wrong.\n' },
          reference,
        ),
      ],
    ]);

    // Every checkpoint carries the finished type's cursor, as the job was claimed with it, beside the cursor of the type this attempt runs.
    const place = { next: TEXT.length, size: LINKING_SIZE, found: 3, emitted: 3, errors: 0 };
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Person: person, Place: place } },
      { jobId: job.metadata.id, completedUnits: ['Place'], unitCursors: { Person: person, Place: place } },
    ]);

    // The finished type is among the finished, with what its cursor counted, from the first report. What was counted of mentions is this attempt's: a cursor carries none.
    const personItem = { value: 'Person', foundCount: 3, persistedCount: 2 };
    const placeItem = { value: 'Place', foundCount: 3, persistedCount: 3 };
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }, { requestParams: TYPES }),
      onPlace(job, 50, 1, 3, undefined, 2, [personItem]),
      onPlace(job, 50, 1, 3, 3, 2, [personItem]),
      onPlace(job, 50, 1, 6, 3, 5, [personItem]),
      onPlace(job, 80, 2, 6, 3, 5, [personItem, placeItem]),
      report(job, 100, { code: 'complete-created', count: 5, motivation: 'linking' }, { entitiesExpected: 3, completedItems: [personItem, placeItem], requestParams: TYPES }),
    ]);

    // The counts are the whole job's: the finished type's three, two and one, and this attempt's three and three.
    expect(completion).toEqual({ ...identity(job), attempt: 2, result: { found: 6, persisted: 5, errors: 1 }, durability: 'acknowledged' });
  });

  it('names finished, with its cursor and with nothing asked, an entity type whose cursor stands at the end of the text', async () => {
    const w = world();
    const agent = w.agents[0]!;
    // The earlier attempt established Person's last batch, and died before it named the type finished.
    const person = { next: TEXT.length, size: LINKING_SIZE, found: 2, emitted: 2, errors: 0 };
    const job = markJob(w, 'resume-ended', { motivation: 'linking', entityTypes: ['Person', 'Place'] }, { retryCount: 1, unitCursors: { Person: person } });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ response: JSON.stringify([{ exact: 'London', entityType: 'Place', prefix: 'engine in ', suffix: ', but' }]) }, { response: '1' });
    const served = await w.start();
    const completion = await settled(served, job);

    // Nothing is asked about the type that has no text left.
    expectGenerations(w.ollama.generations, [generation(agent.model, 'linking-place', EXTRACTION, FORMATS.linking), generation(agent.model, 'linking-place-count', COUNT)]);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(
          w.generator(),
          resourceId,
          'linking',
          'NqihZbhiWq88D2HD70JAq',
          {
            start: 158,
            end: 164,
            exact: 'London',
            prefix: 'on the Analytical Engine.\n\nCharles Babbage designed the engine in ',
            suffix: ', but it was never built. Lovelace argued that the engine could manipulate',
          },
          [{ type: 'TextualBody', value: 'Place', purpose: 'tagging', format: 'text/plain', language: 'en' }],
        ),
      ],
    ]);

    // The type is named finished before anything is committed, with the cursor the job was claimed with.
    const place = { next: TEXT.length, size: LINKING_SIZE, found: 1, emitted: 1, errors: 0 };
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: ['Person'], unitCursors: { Person: person } },
      { jobId: job.metadata.id, completedUnits: ['Person'], unitCursors: { Person: person, Place: place } },
      { jobId: job.metadata.id, completedUnits: ['Person', 'Place'], unitCursors: { Person: person, Place: place } },
    ]);

    const personItem = { value: 'Person', foundCount: 2, persistedCount: 2 };
    const placeItem = { value: 'Place', foundCount: 1, persistedCount: 1 };
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }, { requestParams: TYPES }),
      // Person: begun, and finished. No piece was asked about, so none was counted and none committed.
      report(job, 20, { code: 'detecting-entities', entityType: 'Person' }, {
        current: { kind: 'entity-type', value: 'Person' }, processed: 0, total: 2, entitiesFound: 2, entitiesEmitted: 2, completedItems: [], requestParams: TYPES,
      }),
      report(job, 50, { code: 'detecting-entities', entityType: 'Person' }, {
        current: { kind: 'entity-type', value: 'Person' }, processed: 1, total: 2, entitiesFound: 2, entitiesEmitted: 2, completedItems: [personItem], requestParams: TYPES,
      }),
      onPlace(job, 50, 1, 2, undefined, 2, [personItem]),
      onPlace(job, 50, 1, 2, 1, 2, [personItem]),
      onPlace(job, 50, 1, 3, 1, 3, [personItem]),
      onPlace(job, 80, 2, 3, 1, 3, [personItem, placeItem]),
      report(job, 100, { code: 'complete-created', count: 3, motivation: 'linking' }, { entitiesExpected: 1, completedItems: [personItem, placeItem], requestParams: TYPES }),
    ]);
    expect(completion).toEqual({ ...identity(job), attempt: 2, result: { found: 3, persisted: 3 }, durability: 'acknowledged' });
  });

  it('counts a unit whose cursor stands at the end of the text by that cursor, and asks nothing about it', async () => {
    const w = world();
    const agent = w.agents[0]!;
    // The earlier attempt asked about Claim to the end of the text, and never began Evidence: three proposed, two recorded, one that made nothing.
    const claim = { next: TEXT.length, size: 2621, found: 3, emitted: 2, errors: 1 };
    const job = markJob(w, 'resume-tagging', { motivation: 'tagging', schemaId: SCHEMA.id, categories: ['Claim', 'Evidence'], schema: SCHEMA }, { retryCount: 1, unitCursors: { Claim: claim } });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ response: JSON.stringify([{ exact: 'nobody tested that claim for a century' }]) });
    const served = await w.start();
    const completion = await settled(served, job);

    // One generation: the category that was never begun.
    expectGenerations(w.ollama.generations, [generation(agent.model, 'tagging-evidence', { num_predict: 5237, num_ctx: 5822, temperature: 0 }, FORMATS.tagging)]);
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(
          w.generator(),
          resourceId,
          'tagging',
          'mX0u-GJ2Asq1XSaDxTpYB',
          {
            start: 267,
            end: 305,
            exact: 'nobody tested that claim for a century',
            prefix: 'argued that the engine could manipulate symbols as well as numbers; ',
            suffix: '.\n\nThe program was naïve by later standards, and London ignored it',
          },
          [
            { type: 'TextualBody', value: 'Evidence', purpose: 'tagging', format: 'text/plain', language: 'en' },
            { type: 'TextualBody', value: 'argument', purpose: 'classifying', format: 'text/plain' },
          ],
        ),
      ],
    ]);

    // The checkpoint carries the cursor the job was claimed with beside the one this attempt made.
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Claim: claim, Evidence: { next: TEXT.length, size: 2618, found: 1, emitted: 1, errors: 0 } } },
    ]);

    const at = (category: string, processed: number, completedItems: unknown[]) => ({ current: { kind: 'category', value: category }, processed, total: 2, completedItems });
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing-tags' }),
      report(job, 30, { code: 'analyzing-tags' }, at('Claim', 0, [])),
      report(job, 45, { code: 'analyzing-tags' }, at('Evidence', 1, [{ value: 'Claim', foundCount: 3 }])),
      report(job, 60, { code: 'creating-tag-annotations', count: 3 }),
      report(job, 100, { code: 'complete-created', count: 3, motivation: 'tagging' }),
    ]);

    // The counts are the whole job's, by category as in all: the earlier attempt's two for Claim, and this one's for Evidence.
    expect(completion).toEqual({ ...identity(job), attempt: 2, result: { found: 4, persisted: 3, errors: 1, byCategory: { Claim: 2, Evidence: 1 } }, durability: 'acknowledged' });
  });
});
