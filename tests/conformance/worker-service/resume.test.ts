/**
 * A job resumed from the checkpoint an earlier attempt left
 * (WORKER-SERVICE.md § Resuming): a unit partway is taken up at its cursor, a
 * finished unit is not done again, and nothing is committed twice.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, LONG_TEXT, markerHighlight, markJob, report, settled, SMALL_CONTEXT_LENGTH, TEXT, withoutCreated } from './support';

const found = (...markers: number[]) => ({ response: JSON.stringify(markers.map((n) => ({ exact: `marker ${n}` }))) });

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

  it('does not do again a unit an earlier attempt finished', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = markJob(w, 'resume-units', { motivation: 'linking', entityTypes: ['Person', 'Place'] }, { retryCount: 2, completedUnits: ['Person'] });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ response: JSON.stringify([{ exact: 'London', entityType: 'Place', prefix: 'engine in ', suffix: ', but' }]) }, { response: '1' });
    const served = await w.start();
    const completion = await settled(served, job);

    expect(served.payloads('job:start')).toEqual([{ ...identity(job), attempt: 3 }]);
    // Only the unfinished type is asked for: its extraction, and its count.
    expectGenerations(w.ollama.generations, [
      generation(agent.model, 'linking-place', { num_predict: 5318, num_ctx: 5758, temperature: 0 }, FORMATS.linking),
      generation(agent.model, 'linking-place-count', { num_predict: 16, num_ctx: 244, temperature: 0 }),
    ]);
    const commits = served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']));
    expect(commits).toHaveLength(1);
    expect(commits[0]!.map((a) => (a['body'] as Array<{ value: string }>)[0]!.value)).toEqual(['Place']);
    expect((commits[0]![0]!['target'] as { source: string; selector: Array<Record<string, unknown>> }).selector[0]).toEqual({ type: 'TextPositionSelector', start: 158, end: 164 });
    expect(TEXT.slice(158, 164)).toBe('London');
    expect(resourceId).toBe('res-ws-resume-units');
    expect(completion).toMatchObject({ ...identity(job), attempt: 3, durability: 'acknowledged' });
  });
});
