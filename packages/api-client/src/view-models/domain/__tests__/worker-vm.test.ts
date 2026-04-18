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

function emitClaimResult(
  sse: ReturnType<typeof createSSEStream>,
  correlationId: string,
  response: Record<string, unknown>,
) {
  sse.push(sseChunk('bus-event', JSON.stringify({
    channel: 'job:claimed',
    payload: { correlationId, response },
  })));
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

  it('start connects to bus subscribe with required channels', async () => {
    mockSSEResponse();

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['highlight-annotation'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/bus/subscribe');
    expect(url).toContain('channel=job%3Aqueued');
    expect(url).toContain('channel=job%3Aclaimed');
    expect(url).toContain('channel=job%3Aclaim-failed');

    vm.dispose();
  });

  it('claims job on matching job:queued bus event via bus emit', async () => {
    const sse = mockSSEResponse();

    // The claim will go through bus emit (POST /bus/emit)
    mockFetch.mockResolvedValueOnce({ ok: true, status: 202 });

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

    // Wait for the bus emit (claim request)
    await vi.waitFor(() => {
      const calls = mockFetch.mock.calls;
      return calls.some((c: unknown[]) => {
        const url = c[0] as string;
        return url.includes('/bus/emit');
      });
    });

    // Extract correlationId from the claim emit
    const emitCall = mockFetch.mock.calls.find((c: unknown[]) => (c[0] as string).includes('/bus/emit'));
    const body = JSON.parse((emitCall![1] as { body: string }).body);
    expect(body.channel).toBe('job:claim');

    // Simulate the backend responding with job:claimed
    emitClaimResult(sse, body.payload.correlationId, {
      params: { density: 5 },
      metadata: { userId: 'did:web:example.com:users:test' },
    });

    const job = await firstValueFrom(vm.activeJob$.pipe(filter((j) => j !== null)));
    expect(job!.jobId).toBe('j-1');
    expect(job!.userId).toBe('did:web:example.com:users:test');
    expect(job!.params).toEqual({ density: 5 });

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

  it('handles claim failure gracefully', async () => {
    const sse = mockSSEResponse();

    mockFetch.mockResolvedValueOnce({ ok: true, status: 202 });

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

    await vi.waitFor(() => {
      const calls = mockFetch.mock.calls;
      return calls.some((c: unknown[]) => (c[0] as string).includes('/bus/emit'));
    });

    const emitCall = mockFetch.mock.calls.find((c: unknown[]) => (c[0] as string).includes('/bus/emit'));
    const body = JSON.parse((emitCall![1] as { body: string }).body);

    // Respond with claim failure
    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'job:claim-failed',
      payload: { correlationId: body.payload.correlationId, message: 'Job already claimed' },
    })));

    await new Promise((r) => setTimeout(r, 50));
    expect(await firstValueFrom(vm.activeJob$)).toBeNull();
    expect(await firstValueFrom(vm.isProcessing$)).toBe(false);

    vm.dispose();
  });

  it('emitEvent delegates to ActorVM.emit — global for non-broadcast events', async () => {
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

  it('emitEvent scopes resource-broadcast events to payload.resourceId', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const vm = createWorkerVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      jobTypes: ['generation'],
    });

    await vm.emitEvent('yield:progress', { resourceId: 'res-1', percentage: 42 });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/bus/emit',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel: 'yield:progress',
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
