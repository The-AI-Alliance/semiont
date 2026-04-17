import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { createWorkerVM } from '../worker-vm';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function sseChunk(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function createSSEStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

function mockSSEResponse() {
  const sse = createSSEStream();
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: sse.stream,
  });
  return sse;
}

function emitJobQueued(
  sse: ReturnType<typeof createSSEStream>,
  payload: Record<string, unknown>,
) {
  sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'job:queued', payload })));
}

describe('createWorkerVM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('start connects to bus subscribe with job:queued channel', async () => {
    mockSSEResponse();

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation', 'comment-annotation'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:4000/bus/subscribe?channel=job%3Aqueued');

    vm.dispose();
  });

  it('claims job on matching job:queued bus event', async () => {
    const sse = mockSSEResponse();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        params: { density: 5 },
        metadata: { userId: 'did:web:example.com:users:test' },
      }),
    });

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    emitJobQueued(sse, {
      jobId: 'j-1',
      jobType: 'highlight-annotation',
      resourceId: 'res-1',
    });

    const job = await firstValueFrom(vm.activeJob$.pipe(filter((j) => j !== null)));
    expect(job!.jobId).toBe('j-1');
    expect(job!.userId).toBe('did:web:example.com:users:test');
    expect(job!.params).toEqual({ density: 5 });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/jobs/j-1/claim',
      expect.objectContaining({ method: 'POST' }),
    );

    vm.dispose();
  });

  it('filters by jobTypes — ignores non-matching types', async () => {
    const sse = mockSSEResponse();

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    emitJobQueued(sse, {
      jobId: 'j-2',
      jobType: 'comment-annotation',
      resourceId: 'res-1',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await firstValueFrom(vm.isProcessing$)).toBe(false);

    vm.dispose();
  });

  it('handles 409 (already claimed) gracefully', async () => {
    const sse = mockSSEResponse();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 409 });

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    emitJobQueued(sse, {
      jobId: 'j-2',
      jobType: 'highlight-annotation',
      resourceId: 'res-1',
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

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
          scope: 'res-1',
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
});
