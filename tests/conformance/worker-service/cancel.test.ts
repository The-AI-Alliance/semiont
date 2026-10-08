/**
 * A cancellation of the job a worker holds (WORKER-SERVICE.md
 * § Cancellation): a linking job stops when the entity type it is on is
 * finished, and says `job:cancel` with the types it finished.
 */
import { expect, it } from 'vitest';
import { eachWorkerService } from '../harness/worker-service-world';
import { markJob, settled, TEXT } from './support';

eachWorkerService('a job that is cancelled', (world) => {
  it('finishes the entity type a linking job is on, begins no other, and says job:cancel with what it finished', async () => {
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
    expect(served.sequence()).toEqual([
      'emit job:claim',
      'emit job:start',
      'emit browse:resource-requested',
      `GET /resources/${resourceId}`,
      'emit mark:commit',
      'emit job:checkpoint',
      'emit job:checkpoint',
      'emit job:cancel',
      'emit job:claim',
    ]);
    // A cancel names the job and what it finished, and states no attempt.
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark', completedUnits: ['Person'] });
    expect(served.emits('job:complete')).toEqual([]);
    expect(served.emits('job:fail')).toEqual([]);
  });
});
