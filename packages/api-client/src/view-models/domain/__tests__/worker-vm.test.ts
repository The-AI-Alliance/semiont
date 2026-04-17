import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { createWorkerVM } from '../worker-vm';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function setupEventSource() {
  const listeners = new Map<string, Function>();
  const instance = {
    addEventListener: (event: string, handler: Function) => listeners.set(event, handler),
    close: vi.fn(),
    listeners,
  };
  const calls: string[] = [];
  function MockEventSource(this: unknown, url: string) {
    calls.push(url);
    Object.assign(this as Record<string, unknown>, instance);
  }
  vi.stubGlobal('EventSource', MockEventSource);
  return { instance, calls };
}

function emitBusEvent(
  es: ReturnType<typeof setupEventSource>['instance'],
  channel: string,
  payload: Record<string, unknown>,
) {
  const handler = es.listeners.get('bus-event')!;
  handler({ data: JSON.stringify({ channel, payload }) });
}

describe('createWorkerVM', () => {
  let esInstance: ReturnType<typeof setupEventSource>['instance'];
  let esCalls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    const { instance, calls } = setupEventSource();
    esInstance = instance;
    esCalls = calls;
  });

  it('initializes with no active job', async () => {
    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    expect(await firstValueFrom(vm.activeJob$)).toBeNull();
    expect(await firstValueFrom(vm.isProcessing$)).toBe(false);
    expect(await firstValueFrom(vm.jobsCompleted$)).toBe(0);

    vm.dispose();
  });

  it('start connects to bus subscribe with job:queued channel', () => {
    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation', 'comment-annotation'],
    });

    vm.start();

    expect(esCalls).toEqual([
      'http://localhost:4000/bus/subscribe?channel=job%3Aqueued',
    ]);

    vm.dispose();
  });

  it('claims job on matching job:queued bus event', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ params: { density: 5 } }),
    });

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.start();

    emitBusEvent(esInstance, 'job:queued', {
      jobId: 'j-1',
      jobType: 'highlight-annotation',
      resourceId: 'res-1',
    });

    const job = await firstValueFrom(vm.activeJob$.pipe(filter((j) => j !== null)));
    expect(job!.jobId).toBe('j-1');
    expect(job!.params).toEqual({ density: 5 });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/jobs/j-1/claim',
      expect.objectContaining({ method: 'POST' }),
    );

    vm.dispose();
  });

  it('filters by jobTypes — ignores non-matching types', async () => {
    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.start();

    emitBusEvent(esInstance, 'job:queued', {
      jobId: 'j-2',
      jobType: 'comment-annotation',
      resourceId: 'res-1',
    });

    await vi.waitFor(() => {});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await firstValueFrom(vm.isProcessing$)).toBe(false);

    vm.dispose();
  });

  it('handles 409 (already claimed) gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 409 });

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.start();

    emitBusEvent(esInstance, 'job:queued', {
      jobId: 'j-2',
      jobType: 'highlight-annotation',
      resourceId: 'res-1',
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    expect(await firstValueFrom(vm.activeJob$)).toBeNull();
    expect(await firstValueFrom(vm.isProcessing$)).toBe(false);

    vm.dispose();
  });

  it('emitEvent delegates to ActorVM.emit', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    await vm.emitEvent('mark:progress', { resourceId: 'res-1', percentage: 42 });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/bus/emit',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel: 'mark:progress',
          payload: { resourceId: 'res-1', percentage: 42 },
        }),
      }),
    );

    vm.dispose();
  });

  it('completeJob increments counter and clears active job', async () => {
    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.completeJob();

    expect(await firstValueFrom(vm.activeJob$)).toBeNull();
    expect(await firstValueFrom(vm.isProcessing$)).toBe(false);
    expect(await firstValueFrom(vm.jobsCompleted$)).toBe(1);

    vm.dispose();
  });

  it('failJob emits error and clears active job', async () => {
    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    const errorsPromise = firstValueFrom(vm.errors$);
    vm.failJob('j-3', 'LLM timeout');

    const error = await errorsPromise;
    expect(error).toEqual({ jobId: 'j-3', error: 'LLM timeout' });
    expect(await firstValueFrom(vm.isProcessing$)).toBe(false);

    vm.dispose();
  });

  it('stop closes EventSource via ActorVM', () => {
    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.start();
    vm.stop();

    expect(esInstance.close).toHaveBeenCalled();

    vm.dispose();
  });
});
