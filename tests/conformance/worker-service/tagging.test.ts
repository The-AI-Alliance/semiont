/**
 * A `mark` job of motivation `tagging`, end to end (WORKER-SERVICE.md
 * § Detection, § The five kinds of mark job): one unit for each category of
 * the schema the dispatcher handed over with the job, each asked of the whole
 * text.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, LONG_TEXT, markJob, MIDDLING_CONTEXT_LENGTH, report, settled, TEXT, textAnnotation, withoutCreated } from './support';

/** The schema the job's `schemaId` names, as the dispatcher adds it to the job it hands over. */
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

eachWorkerService('a tagging job', (world) => {
  it('asks its model for each category in turn, and commits each tag with its category and the schema it is of', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'tagging', { motivation: 'tagging', schemaId: SCHEMA.id, categories: ['Claim', 'Evidence'], schema: SCHEMA });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ response: JSON.stringify([{ exact: 'London was wrong.' }]) }, { response: '[]' });
    const served = await w.start();
    const completion = await settled(served, job);

    expectGenerations(w.ollama.generations, [
      generation(agent.model, 'tagging-claim', { num_predict: 5242, num_ctx: 5819, temperature: 0 }, FORMATS.tagging),
      generation(agent.model, 'tagging-evidence', { num_predict: 5237, num_ctx: 5822, temperature: 0 }, FORMATS.tagging),
    ]);

    // A category with nothing to commit commits nothing, and still says where it got to.
    expect(served.sequence()).toEqual([
      'emit job:claim',
      'emit job:start',
      'emit browse:resource-requested',
      `GET /resources/${resourceId}`,
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
            'tagging',
            'htF9JvtYLflP_yBTSknGT',
            { start: 373, end: 390, exact: 'London was wrong.', prefix: 'The program was naïve by later standards, and London ignored it. ', suffix: '\n' },
            // Two bodies: the category, and the schema it is a category of.
            [
              { type: 'TextualBody', value: 'Claim', purpose: 'tagging', format: 'text/plain', language: 'en' },
              { type: 'TextualBody', value: 'argument', purpose: 'classifying', format: 'text/plain' },
            ],
          ),
        ],
      },
    ]);

    // A tagging job's units are its categories: each has a cursor of its own, and none is ever said to be finished.
    const claim = { next: TEXT.length, size: 2621, found: 1, emitted: 1, errors: 0 };
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Claim: claim } },
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Claim: claim, Evidence: { next: TEXT.length, size: 2618, found: 0, emitted: 0, errors: 0 } } },
    ]);

    const at = (category: string, processed: number, completedItems: unknown[]) => ({ current: { kind: 'category', value: category }, processed, total: 2, completedItems });
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing-tags' }),
      report(job, 30, { code: 'analyzing-tags' }, at('Claim', 0, [])),
      report(job, 60, { code: 'creating-tag-annotations', count: 1 }),
      report(job, 45, { code: 'analyzing-tags' }, at('Evidence', 1, [{ value: 'Claim', foundCount: 1 }])),
      // Said after each category's answer, with what the job has made so far.
      report(job, 60, { code: 'creating-tag-annotations', count: 1 }),
      report(job, 100, { code: 'complete-created', count: 1, motivation: 'tagging' }),
    ]);

    expect(completion).toEqual({ ...identity(job), result: { found: 1, persisted: 1, byCategory: { Claim: 1 } }, durability: 'acknowledged' });
  });

  it('says how far through a category it is at the boundary between two pieces of the text', async () => {
    const w = world();
    w.ollama.show = { contextLength: MIDDLING_CONTEXT_LENGTH };
    const job = markJob(w, 'tagging-pieces', { motivation: 'tagging', schemaId: SCHEMA.id, categories: ['Claim', 'Evidence'], schema: SCHEMA }, {}, LONG_TEXT);
    const resourceId = String(job.params.resourceId);
    // The text is two pieces for each category. No answer names a marker of the overlap.
    const found = (marker: number) => ({ response: JSON.stringify([{ exact: `marker ${marker}` }]) });
    w.ollama.script(found(103), found(702), found(205), found(801));
    const served = await w.start();
    const completion = await settled(served, job);

    expect(w.ollama.generations).toHaveLength(4);
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
      'emit mark:commit',
      'emit job:checkpoint',
      'emit job:complete',
      'emit job:claim',
    ]);
    expect(w.commits.map((c) => c.annotations.length)).toEqual([1, 1, 1, 1]);

    // For each category the first piece ends where the fifth paragraph does, and the second starts 256 code points before that.
    const boundary = 2147;
    const claim = (next: number, found: number) => ({ next, size: 690, found, emitted: found, errors: 0 });
    const evidence = (next: number, found: number) => ({ next, size: 687, found, emitted: found, errors: 0 });
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Claim: claim(boundary, 1) } },
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Claim: claim(LONG_TEXT.length, 2) } },
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Claim: claim(LONG_TEXT.length, 2), Evidence: evidence(boundary, 1) } },
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { Claim: claim(LONG_TEXT.length, 2), Evidence: evidence(LONG_TEXT.length, 2) } },
    ]);

    const at = (category: string, processed: number, completedItems: unknown[]) => ({ current: { kind: 'category', value: category }, processed, total: 2, completedItems });
    const claimed = [{ value: 'Claim', foundCount: 2 }];
    // The 30 points from 30 to 60 are shared among the categories, and a boundary stands in its category's share where the
    // cursor stands in the text: 2147 of 3847 code points, 0.558 of a category. Of two categories that is 8.4 points for the
    // first, and 23.4 for the second, which has the whole of the first before it.
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }),
      report(job, 30, { code: 'analyzing-tags' }),
      // Claim: begun, its first piece, the boundary, its second piece. The second is the text's last, so no boundary follows it.
      report(job, 30, { code: 'analyzing-tags' }, at('Claim', 0, [])),
      report(job, 60, { code: 'creating-tag-annotations', count: 1 }),
      report(job, 38, { code: 'analyzing-tags' }, at('Claim', 0, [])),
      report(job, 60, { code: 'creating-tag-annotations', count: 2 }),
      // Evidence: the same four.
      report(job, 45, { code: 'analyzing-tags' }, at('Evidence', 1, claimed)),
      report(job, 60, { code: 'creating-tag-annotations', count: 3 }),
      report(job, 53, { code: 'analyzing-tags' }, at('Evidence', 1, claimed)),
      report(job, 60, { code: 'creating-tag-annotations', count: 4 }),
      report(job, 100, { code: 'complete-created', count: 4, motivation: 'tagging' }),
    ]);

    expect(completion).toEqual({ ...identity(job), result: { found: 4, persisted: 4, byCategory: { Claim: 2, Evidence: 2 } }, durability: 'acknowledged' });
  });
});
