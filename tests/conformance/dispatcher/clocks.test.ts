/**
 * The dispatcher's clocks (JOBS.md § Periodic work, § `job:report-progress`),
 * run fast: the document's `timing` shrinks each to a fraction of a second.
 */
import { expect, it } from 'vitest';
import { marks, refOf, resourceIdOf, settle, withDispatcher } from '../harness/dispatcher-world';

const TICK = 300;
const STALE = 1_500;

withDispatcher('the re-announce tick and the dead-worker sweep', (world) => {
  it('announces an unclaimed pending job again at every tick', async () => {
    const jobId = await (await world().person('creator')).created('mark', { motivation: 'highlighting' }, resourceIdOf());
    await world().announced(jobId, 3, 5_000);
  });

  it('re-queues a job whose worker went silent, when its budget allows: announced again, and claimed with one retry counted', async () => {
    const { creator, worker, job } = await world().running({ motivation: 'commenting' });
    const announced = world().announcements(job.metadata.id).length;
    await creator.until(job.metadata.id, 'the sweep to re-queue the job', (s) => s.status === 'pending', 10_000);
    await world().announced(job.metadata.id, announced + 1);
    const retried = await worker.claimed([marks('commenting')]);
    expect(retried.metadata.retryCount).toBe(1);
    await worker.complete(refOf(retried));
  });

  it('fails a silent job with no budget left, saying its worker is presumed dead', async () => {
    const { creator, job } = await world().running('yield');
    const status = await creator.until(job.metadata.id, 'the sweep to fail the job', (s) => s.status === 'failed', 10_000);
    expect(status.error).toMatch(/presumed dead/);
  });

  it('leaves alone a job whose worker keeps reporting progress', async () => {
    const { creator, worker, job, ref } = await world().running();
    for (let elapsed = 0; elapsed < 2 * STALE; elapsed += 400) {
      await worker.reportProgress(ref, Math.min(99, elapsed / 40));
      await settle(400);
    }
    expect((await creator.statusOf(job.metadata.id)).status).toBe('running');
    await worker.complete(ref);
  });

  it('leaves alone a job whose worker keeps checkpointing', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'linking', entityTypes: ['Person', 'Place'] });
    for (let elapsed = 0; elapsed < 2 * STALE; elapsed += 400) {
      await worker.checkpoint(job.metadata.id, [`unit-${elapsed}`]);
      await settle(400);
    }
    expect((await creator.statusOf(job.metadata.id)).status).toBe('running');
    await worker.complete(ref);
  });

  it('keeps the checkpoint of a job it re-queues', async () => {
    const { creator, worker, job } = await world().running({ motivation: 'linking', entityTypes: ['Person', 'Place'] });
    const cursor = { next: 2, size: 5, found: 3, emitted: 2, errors: 1 };
    await worker.checkpoint(job.metadata.id, ['Person'], { Place: cursor });
    await creator.until(job.metadata.id, 'the sweep to re-queue the job', (s) => s.status === 'pending', 10_000);
    const retried = await worker.claimed([marks('linking')]);
    expect(retried.metadata).toMatchObject({ completedUnits: ['Person'], unitCursors: { Place: cursor } });
    await worker.complete(refOf(retried));
  });
}, { timing: { tickMs: TICK, staleRunningMs: STALE, progressWriteIntervalMs: 100 } });

withDispatcher('retention', (world) => {
  it('deletes finished jobs past the window, and keeps pending and running ones', async () => {
    const creator = await world().person('creator');
    const completed = await world().running();
    await completed.worker.complete(completed.ref, { found: 0, persisted: 0 });
    const failed = await world().running('yield');
    await failed.worker.fail(failed.ref, 'broken');
    const cancelled = await creator.created('mark', { motivation: 'commenting' }, resourceIdOf());
    await creator.cancelRequest({ jobId: cancelled });
    const running = await world().running({ motivation: 'assessing' });
    const pending = await creator.created('mark', { motivation: 'commenting' }, resourceIdOf());

    for (const id of [completed.job.metadata.id, failed.job.metadata.id, cancelled]) {
      await expect.poll(async () => (await creator.status(id)).payload['message'], { timeout: 10_000 }).toBe('Job not found');
    }
    expect((await creator.statusOf(running.job.metadata.id)).status).toBe('running');
    expect((await creator.statusOf(pending)).status).toBe('pending');
  });
}, { timing: { retentionMs: 1_000, retentionSweepMs: 300 } });

withDispatcher('the progress throttle', (world) => {
  it('drops a report arriving inside the window after the last one written, and writes the next one outside it', async () => {
    const { creator, worker, job, ref } = await world().running();
    const percentage = async () => ((await creator.statusOf(job.metadata.id)).progress as { percentage?: number }).percentage;
    await worker.reportProgress(ref, 10);
    await expect.poll(percentage).toBe(10);
    await worker.reportProgress(ref, 20);
    await settle();
    expect(await percentage()).toBe(10);
    await settle(world().settings.timing.progressWriteIntervalMs);
    await worker.reportProgress(ref, 30);
    await expect.poll(percentage).toBe(30);
  });
}, { timing: { progressWriteIntervalMs: 2_000 } });
