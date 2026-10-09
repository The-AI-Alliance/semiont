/**
 * A `mark` job of motivation `commenting`, end to end (WORKER-SERVICE.md
 * § Detection, § The five kinds of mark job): asked with instructions, a
 * tone, a density and both of its languages.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, markJob, report, settled, TEXT, textAnnotation, withoutCreated } from './support';

/** A comment's body: what the model wrote, as plain text, in the language the job asked for. */
const comment = (value: string) => [{ type: 'TextualBody', value, purpose: 'commenting', format: 'text/plain', language: 'fr' }];

eachWorkerService('a commenting job', (world) => {
  it('asks as its instructions, tone, density and languages say, and commits each comment as the body of its span', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'commenting', {
      motivation: 'commenting',
      instructions: 'Explain who each person was.',
      tone: 'scholarly',
      density: 4,
      language: 'fr',
      sourceLanguage: 'en',
    });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({
      response: JSON.stringify([
        { exact: 'Ada Lovelace', prefix: '', suffix: ' published', comment: 'Mathématicienne anglaise (1815–1852).' },
        { exact: 'Charles Babbage', comment: 'Inventeur de la machine analytique.' },
        // A comment that says nothing is no proposal: it is neither committed nor counted.
        { exact: 'Bernoulli numbers', comment: '   ' },
      ]),
    });
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
    expectGenerations(w.ollama.generations, [generation(agent.model, 'commenting', { num_predict: 5320, num_ctx: 5756, temperature: 0 }, FORMATS.commenting)]);

    expect(served.payloads('mark:commit').map((p) => ({ ...p, annotations: withoutCreated(p['annotations']) }))).toEqual([
      {
        resourceId,
        jobId: job.metadata.id,
        annotations: [
          // At the very start of the text there is nothing before it, and its selector states no prefix.
          textAnnotation(
            w.generator(),
            resourceId,
            'commenting',
            'xF0gdAhKtOfhw1sOLoMFJ',
            { start: 0, end: 12, exact: 'Ada Lovelace', suffix: ' published the first program in 1843 — a method for computing Bernoulli' },
            comment('Mathématicienne anglaise (1815–1852).'),
          ),
          textAnnotation(
            w.generator(),
            resourceId,
            'commenting',
            'k-1xPhvsdrjKL9y6bdx2f',
            {
              start: 119,
              end: 134,
              exact: 'Charles Babbage',
              prefix: 'method for computing Bernoulli numbers on the Analytical Engine.\n\n',
              suffix: ' designed the engine in London, but it was never built. Lovelace',
            },
            comment('Inventeur de la machine analytique.'),
          ),
        ],
      },
    ]);
    expect(served.payloads('job:checkpoint')).toEqual([
      { jobId: job.metadata.id, completedUnits: [], unitCursors: { commenting: { next: TEXT.length, size: 2659, found: 2, emitted: 2, errors: 0 } } },
    ]);

    // What the job was asked with is echoed on every report: the instructions, the tone, the density.
    const asked = {
      requestParams: [
        { label: 'instructions', value: 'Explain who each person was.' },
        { label: 'tone', value: 'scholarly' },
        { label: 'density', value: '4' },
      ],
    };
    expectProgress(served, job, [
      report(job, 10, { code: 'loading' }, asked),
      report(job, 30, { code: 'analyzing' }, asked),
      report(job, 60, { code: 'creating-annotations', count: 2 }, asked),
      report(job, 100, { code: 'complete-created', count: 2, motivation: 'commenting' }, asked),
    ]);
    expect(completion).toEqual({ ...identity(job), result: { found: 2, persisted: 2 }, durability: 'acknowledged' });
  });
});
