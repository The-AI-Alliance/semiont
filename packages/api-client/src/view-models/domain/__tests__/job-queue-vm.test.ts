import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { createJobQueueVM } from '../job-queue-vm';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';

describe('createJobQueueVM', () => {
  let tc: TestClient;

  beforeEach(() => { tc = makeTestClient(); });
  afterEach(() => { tc.bus.destroy(); });

  it('initializes with empty jobs list', async () => {
    const vm = createJobQueueVM(tc.client);
    const jobs = await firstValueFrom(vm.jobs$);
    expect(jobs).toEqual([]);
    vm.dispose();
  });

  it('tracks job:queued as pending job', async () => {
    const vm = createJobQueueVM(tc.client);

    tc.bus.get('job:queued').next({
      jobId: 'j-1',
      jobType: 'highlight-annotation',
      resourceId: 'res-1', userId: 'u-1' });

    const jobs = await firstValueFrom(vm.jobs$.pipe(filter((j) => j.length > 0)));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe('j-1');
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].type).toBe('highlight-annotation');

    vm.dispose();
  });

  it('emits jobCreated$ on job:queued', async () => {
    const vm = createJobQueueVM(tc.client);
    const created = firstValueFrom(vm.jobCreated$);

    tc.bus.get('job:queued').next({
      jobId: 'j-2',
      jobType: 'generation',
      resourceId: 'res-2', userId: 'u-1' });

    const job = await created;
    expect(job.jobId).toBe('j-2');

    vm.dispose();
  });

  it('updates job to complete on job:complete', async () => {
    const vm = createJobQueueVM(tc.client);

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

    const jobs = await firstValueFrom(vm.jobs$.pipe(filter((j) => j.some((x) => x.status === 'complete'))));
    expect(jobs[0].status).toBe('complete');
    expect(jobs[0].result).toEqual({ highlightsFound: 5, highlightsCreated: 5 });

    vm.dispose();
  });

  it('emits jobCompleted$ on job:complete', async () => {
    const vm = createJobQueueVM(tc.client);
    const completed = firstValueFrom(vm.jobCompleted$);

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

    vm.dispose();
  });

  it('updates job to failed on job:fail', async () => {
    const vm = createJobQueueVM(tc.client);

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

    const jobs = await firstValueFrom(vm.jobs$.pipe(filter((j) => j.some((x) => x.status === 'failed'))));
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].error).toBe('LLM timeout');

    vm.dispose();
  });

  it('pendingByType$ counts pending jobs by type', async () => {
    const vm = createJobQueueVM(tc.client);

    tc.bus.get('job:queued').next({ jobId: 'j-a', jobType: 'highlight-annotation', resourceId: 'r-1', userId: 'u-1' });
    tc.bus.get('job:queued').next({ jobId: 'j-b', jobType: 'highlight-annotation', resourceId: 'r-2', userId: 'u-1' });
    tc.bus.get('job:queued').next({ jobId: 'j-c', jobType: 'generation', resourceId: 'r-3', userId: 'u-1' });

    const counts = await firstValueFrom(vm.pendingByType$.pipe(
      filter((m) => m.size > 0),
    ));
    expect(counts.get('highlight-annotation')).toBe(2);
    expect(counts.get('generation')).toBe(1);

    vm.dispose();
  });

  it('runningJobs$ filters to running status', async () => {
    const vm = createJobQueueVM(tc.client);

    tc.bus.get('job:queued').next({ jobId: 'j-x', jobType: 'highlight-annotation', resourceId: 'r-1', userId: 'u-1' });

    const running = await firstValueFrom(vm.runningJobs$);
    expect(running).toHaveLength(0);

    vm.dispose();
  });

  it('stops responding after dispose', () => {
    const vm = createJobQueueVM(tc.client);
    vm.dispose();

    const received: unknown[] = [];
    vm.jobCreated$.subscribe((j) => received.push(j));

    tc.bus.get('job:queued').next({ jobId: 'j-z', jobType: 'generation', resourceId: 'r-1', userId: 'u-1' });
    expect(received).toHaveLength(0);
  });
});
