/**
 * Where a span a model proposes is in the text (WORKER-SERVICE.md
 * § Anchoring): a quote the text does not have character for character is
 * looked for again, more loosely, as specs/src/annotations/reconcile-cases.json
 * states; what is found is committed as the text's own words at the text's
 * offsets, and what is not is counted and not committed.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { identity, markJob, settled, TEXT, textAnnotation, withoutCreated } from './support';

eachWorkerService('a span that is not in the text character for character', (world) => {
  it('commits a quote one edit from the text or apart from it by letter case, as the text has it, and counts one the rule allows no edit', async () => {
    const w = world();
    const job = markJob(w, 'anchoring', { motivation: 'highlighting' });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({
      response: JSON.stringify([
        // Seventeen code points, one letter from `Bernoulli numbers`: fewer than twenty, so no edit is allowed, and it is nowhere.
        { exact: 'Bernoulli nunbers' },
        // Twenty-one code points, one letter from `the Analytical Engine`: one edit is allowed, and that is the one stretch one edit away.
        { exact: 'the Analytical Engime' },
        // The text's words but for their letter case.
        { exact: 'CHARLES BABBAGE' },
        // Only white space, and nothing at all: neither is a span.
        { exact: ' \n' },
        { exact: '' },
      ]),
    });
    const served = await w.start();
    const completion = await settled(served, job);

    expect(w.ollama.generations).toHaveLength(1);
    // What is committed is the text's own words, where the text has them: never the model's spelling.
    expect(TEXT.slice(95, 116)).toBe('the Analytical Engine');
    expect(TEXT.slice(119, 134)).toBe('Charles Babbage');
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        textAnnotation(w.generator(), resourceId, 'highlighting', 'pNILL5ANCREjMJG0MZlFy', {
          start: 95,
          end: 116,
          exact: 'the Analytical Engine',
          prefix: 'first program in 1843 — a method for computing Bernoulli numbers on ',
          suffix: '.\n\nCharles Babbage designed the engine in London, but it was never',
        }),
        textAnnotation(w.generator(), resourceId, 'highlighting', 'ft_LL8CCi7gl7eQg5lnrA', {
          start: 119,
          end: 134,
          exact: 'Charles Babbage',
          prefix: 'method for computing Bernoulli numbers on the Analytical Engine.\n\n',
          suffix: ' designed the engine in London, but it was never built. Lovelace',
        }),
      ],
    ]);
    // Five proposed, two recorded, three that are no span: the one no edit is allowed, the white space, and the empty one.
    expect(served.payloads('job:checkpoint')).toEqual([{ jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next: TEXT.length, size: 2641, found: 5, emitted: 2, errors: 3 } } }]);
    expect(completion).toEqual({ ...identity(job), result: { found: 5, persisted: 2, errors: 3 }, durability: 'acknowledged' });
  });
});
