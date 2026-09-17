/**
 * `job:status-requested` — the job-status request/reply channel.
 *
 * Wired in `startMakeMeaning` rather than in the handlers module, and it was
 * the one bus channel in the service with no test at all: a client asking for
 * a job's status got its answer, its not-found, or its failure entirely
 * unexercised.
 *
 * The two failure paths are what matter. A missing job must answer on
 * `job:status-failed` rather than resolve with an empty status — a caller
 * awaiting a reply cannot tell "no such job" from "job with nothing in it"
 * unless the channel says so — and a throw inside the handler must become a
 * reply too, because this is a request/reply seam and a silent throw strands
 * the caller until its timeout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, timer, take } from 'rxjs';
import { EventBus, jobId, userId, type Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { startMakeMeaning, type MakeMeaningService, type MakeMeaningConfig } from '../service';
import { createTestProject } from './helpers/test-project';
import { stubEmbeddingProbeFetch } from './helpers/smelter-harness';

stubEmbeddingProbeFetch();

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const config: MakeMeaningConfig = {
  gather: { settleTimeoutMs: 15_000 },
  search: { semanticFloor: 0.6 },
  services: {
    graph: { platform: { type: 'posix' }, type: 'memory' },
    vectors: { type: 'memory' },
    embedding: { type: 'ollama', model: 'nomic-embed-text' },
  },
  actors: {
    gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
    matcher: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
  },
  workers: { default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' } },
};

/** First reply on either channel, or 'timeout' if the seam strands the caller.
 *  Read as FRAMES: the correlation key these tests assert on rides the
 *  envelope, so a payload-only read could not tell a routed reply from a
 *  stray broadcast. */
async function replyTo(
  bus: EventBus,
): Promise<{ channel: string; correlationId?: string; body: any }> {
  const ok = firstValueFrom(bus.frames('job:status-result').pipe(take(1)));
  const failed = firstValueFrom(bus.frames('job:status-failed').pipe(take(1)));
  const winner = await Promise.race([
    ok.then((f) => ({ channel: 'job:status-result', correlationId: f.correlationId, body: f.payload })),
    failed.then((f) => ({ channel: 'job:status-failed', correlationId: f.correlationId, body: f.payload })),
    firstValueFrom(timer(2000)).then(() => ({ channel: 'timeout', correlationId: undefined, body: null })),
  ]);
  return winner;
}

describe('job:status-requested', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let bus: EventBus;
  let service: MakeMeaningService;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ project, teardown } = await createTestProject());
    bus = new EventBus();
    service = await startMakeMeaning(project, config, bus, silentLogger);
  }, 30_000);

  afterEach(async () => {
    await service?.stop();
    bus.destroy();
    await teardown();
  });

  it('answers with the job when it exists', async () => {
    // createJob persists a job the caller builds; it returns void.
    const id = jobId('job-status-under-test');
    await service.jobQueue.createJob({
      status: 'pending',
      metadata: {
        id,
        type: 'detect-references',
        userId: userId('did:web:test:users:test'),
        userName: 'Test User', userEmail: 'test@example.org', userDomain: 'example.org',
        created: '2026-08-27T00:00:00.000Z',
        retryCount: 0, maxRetries: 3,
      },
      params: {},
    } as never);

    const pending = replyTo(bus);
    bus.emit('job:status-requested', { jobId: String(id) } as never, { correlationId: 'cid-ok' });

    const reply = await pending;
    expect(reply.channel).toBe('job:status-result');
    expect(reply.correlationId).toBe('cid-ok');
    expect(reply.body.response.jobId).toBe(id);
    expect(reply.body.response.type).toBe('detect-references');
  });

  it('answers job:status-failed for a job that does not exist', async () => {
    // Not a resolve-with-nothing: the caller must be able to distinguish an
    // unknown id from a job it is allowed to see but which has no state yet.
    const pending = replyTo(bus);
    bus.emit('job:status-requested', { jobId: 'job-does-not-exist' } as never, { correlationId: 'cid-missing' });

    const reply = await pending;
    expect(reply.channel).toBe('job:status-failed');
    expect(reply.correlationId).toBe('cid-missing');
    expect(reply.body.message).toMatch(/not found/i);
  });

  it('turns a queue failure into a reply rather than stranding the caller', async () => {
    // A throw inside a request/reply handler is indistinguishable from a lost
    // message at the caller — it waits out its timeout either way.
    vi.spyOn(service.jobQueue, 'getJob').mockRejectedValueOnce(new Error('queue unreadable'));

    const pending = replyTo(bus);
    bus.emit('job:status-requested', { jobId: 'job-any' } as never, { correlationId: 'cid-boom' });

    const reply = await pending;
    expect(reply.channel).toBe('job:status-failed');
    expect(reply.body.message).toContain('queue unreadable');
  });
});
