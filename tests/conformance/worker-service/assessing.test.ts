/**
 * A `mark` job of motivation `assessing`, end to end (WORKER-SERVICE.md
 * § Detection, § The five kinds of mark job): asked with a tone and no
 * instructions, and answered with the same assessment twice.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, markJob, report, settled, TEXT, textAnnotation, withoutCreated } from './support';

eachWorkerService('an assessing job', (world) => {
  it('asks as its tone says, and commits one annotation for a span and an assessment proposed twice', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'assessing', { motivation: 'assessing', tone: 'critical' });
    const resourceId = String(job.params.resourceId);
    const proposed = { exact: 'nobody tested that claim for a century', assessment: 'The text gives no source for this.' };
    w.ollama.script({ response: JSON.stringify([proposed, proposed]) });
    const served = await w.start();
    const completion = await settled(served, job);

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
    expectGenerations(w.ollama.generations, [generation(agent.model, 'assessing', { num_predict: 5219, num_ctx: 5838, temperature: 0 }, FORMATS.assessing)]);

    // An assessment's body is one object, not a list: its text, in the language the job asked for, English when it asked for none.
    expect(served.payloads('mark:commit').map((p) => ({ ...p, annotations: withoutCreated(p['annotations']) }))).toEqual([
      {
        resourceId,
        jobId: job.metadata.id,
        annotations: [
          textAnnotation(
            w.generator(),
            resourceId,
            'assessing',
            'IR7o6S29Rwezi-MGHsfyL',
            {
              start: 267,
              end: 305,
              exact: 'nobody tested that claim for a century',
              prefix: 'argued that the engine could manipulate symbols as well as numbers; ',
              suffix: '.\n\nThe program was naïve by later standards, and London ignored it',
            },
            { type: 'TextualBody', value: 'The text gives no source for this.', purpose: 'assessing', format: 'text/plain', language: 'en' },
          ),
        ],
      },
    ]);
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { assessing: { next: TEXT.length, size: 2609, found: 2, emitted: 1, errors: 0 } } },
    ]);

    const asked = { requestParams: [{ label: 'tone', value: 'critical' }] };
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }, asked),
      report(job, 30, { code: 'analyzing' }, asked),
      report(job, 60, { code: 'creating-annotations', count: 1 }, asked),
      report(job, 100, { code: 'complete-created', count: 1, motivation: 'assessing' }, asked),
    ]);
    // Two proposed, one recorded: the second is the first again.
    expect(completion).toEqual({ ...identity(job), result: { found: 2, persisted: 1 }, durability: 'acknowledged' });
  });
});
