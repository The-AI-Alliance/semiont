/**
 * A `mark` job of motivation `tagging`, end to end (WORKER-SERVICE.md
 * § Detection, § The five kinds of mark job): one unit for each category of
 * the schema the dispatcher handed over with the job, each asked of the whole
 * text.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, markJob, report, settled, TEXT, textAnnotation, withoutCreated } from './support';

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
});
