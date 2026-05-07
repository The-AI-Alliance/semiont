import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { createJobQueueStateUnit } from '../job-queue-state-unit';
import { makeTestClient, type TestClient } from './test-client';

describe('createJobQueueStateUnit', () => {
  let tc: TestClient;

  beforeEach(() => { tc = makeTestClient(); });
  afterEach(() => { tc.bus.destroy(); });

  it('initializes with empty jobs list', async () => {
    const stateUnit = createJobQueueStateUnit(tc.client);
    const jobs = await firstValueFrom(stateUnit.jobs$);
    expect(jobs).toEqual([]);
    stateUnit.dispose();
  });

  it('tracks job:queued as pending job', async () => {
    const stateUnit = createJobQueueStateUnit(tc.client);

    tc.bus.get('job:queued').next({
      jobId: 'j-1',
      jobType: 'highlight-annotation',
      resourceId: 'res-1', userId: 'u-1' });

    const jobs = await firstValueFrom(stateUnit.jobs$.pipe(filter((j) => j.length > 0)));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe('j-1');
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].type).toBe('highlight-annotation');

    stateUnit.dispose();
  });

  it('emits jobCreated$ on job:queued', async () => {
    const stateUnit = createJobQueueStateUnit(tc.client);
    const created = firstValueFrom(stateUnit.jobCreated$);

    tc.bus.get('job:queued').next({
      jobId: 'j-2',
      jobType: 'generation',
      resourceId: 'res-2', userId: 'u-1' });

    const job = await created;
    expect(job.jobId).toBe('j-2');

    stateUnit.dispose();
  });

  it('updates job to complete on job:complete', async () => {
    const stateUnit = createJobQueueStateUnit(tc.client);

    tc.bus.get('job:queued').next({
      jobId: 'j-3',
      jobType: 'highlight-annotation',
      resourceId: 'res-1', userId: 'u-1' });

    tc.bus.get('job:complete').next({
      jobId: 'j-3',
      jobType: 'highlight-annotation',
      resourceId: 'res-1',
      _userId: 'u-1',
      result: { highlightsFound: 5, highlightsCreated: 5 },
    });

    const jobs = await firstValueFrom(stateUnit.jobs$.pipe(filter((j) => j.some((x) => x.status === 'complete'))));
    expect(jobs[0].status).toBe('complete');
    expect(jobs[0].result).toEqual({ highlightsFound: 5, highlightsCreated: 5 });

    stateUnit.dispose();
  });

  it('emits jobCompleted$ on job:complete', async () => {
    const stateUnit = createJobQueueStateUnit(tc.client);
    const completed = firstValueFrom(stateUnit.jobCompleted$);

    tc.bus.get('job:complete').next({
      jobId: 'j-4',
      jobType: 'highlight-annotation',
      resourceId: 'res-1',
      _userId: 'u-1',
      result: { highlightsFound: 0, highlightsCreated: 0 },
    });

    const job = await completed;
    expect(job.jobId).toBe('j-4');
    expect(job.status).toBe('complete');

    stateUnit.dispose();
  });

  it('updates job to failed on job:fail', async () => {
    const stateUnit = createJobQueueStateUnit(tc.client);

    tc.bus.get('job:queued').next({
      jobId: 'j-5',
      jobType: 'generation',
      resourceId: 'res-1', userId: 'u-1' });

    tc.bus.get('job:fail').next({
      jobId: 'j-5',
      jobType: 'generation',
      resourceId: 'res-1',
      _userId: 'u-1',
      error: 'LLM timeout',
    });

    const jobs = await firstValueFrom(stateUnit.jobs$.pipe(filter((j) => j.some((x) => x.status === 'failed'))));
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].error).toBe('LLM timeout');

    stateUnit.dispose();
  });

  it('pendingByType$ counts pending jobs by type', async () => {
    const stateUnit = createJobQueueStateUnit(tc.client);

    tc.bus.get('job:queued').next({ jobId: 'j-a', jobType: 'highlight-annotation', resourceId: 'r-1', userId: 'u-1' });
    tc.bus.get('job:queued').next({ jobId: 'j-b', jobType: 'highlight-annotation', resourceId: 'r-2', userId: 'u-1' });
    tc.bus.get('job:queued').next({ jobId: 'j-c', jobType: 'generation', resourceId: 'r-3', userId: 'u-1' });

    const counts = await firstValueFrom(stateUnit.pendingByType$.pipe(
      filter((m) => m.size > 0),
    ));
    expect(counts.get('highlight-annotation')).toBe(2);
    expect(counts.get('generation')).toBe(1);

    stateUnit.dispose();
  });

  it('runningJobs$ filters to running status', async () => {
    const stateUnit = createJobQueueStateUnit(tc.client);

    tc.bus.get('job:queued').next({ jobId: 'j-x', jobType: 'highlight-annotation', resourceId: 'r-1', userId: 'u-1' });

    const running = await firstValueFrom(stateUnit.runningJobs$);
    expect(running).toHaveLength(0);

    stateUnit.dispose();
  });

  it('stops responding after dispose', () => {
    const stateUnit = createJobQueueStateUnit(tc.client);
    stateUnit.dispose();

    const received: unknown[] = [];
    stateUnit.jobCreated$.subscribe((j) => received.push(j));

    tc.bus.get('job:queued').next({ jobId: 'j-z', jobType: 'generation', resourceId: 'r-1', userId: 'u-1' });
    expect(received).toHaveLength(0);
  });
});
