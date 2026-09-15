/**
 * connectRecord — the actor-less, queue-less record-maintenance root
 * (JOB-QUEUE-DRIVER follow-up, 2026-09-16).
 *
 * `startMakeMeaning` builds a job queue and registers the job-command handlers
 * because the in-process / LocalTransport / embedding seam plays gateway AND
 * worker in one process, and the root-parity gate holds it to that. The
 * `rebuild-projections` CLI is NOT that seam: it reads the event log and
 * re-materializes views, dispatching zero jobs. Building a queue for it was
 * harmless under the fs driver (a scratch-dir queue) and load-bearing under
 * jetstream — a second JetStreamJobQueue on the broker opens the hardcoded
 * durable `gateway-claims` consumer, SPLITS deliveries with the live gateway
 * and parks their leases with no worker attached (job starvation). Ruling M:
 * the gateway is the SOLE broker holder.
 *
 * `connectRecord` is the root a job-dispatching-nothing tool uses — stores
 * only, no actors, no job queue, no bus handlers — so it opens no broker
 * consumer whatever `[services.jobs]` names. This gate is the inverse of
 * root-parity: that one asserts the in-process root DOES observe `job:*`;
 * this one asserts the record root does NOT.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, type Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { connectRecord, type MakeMeaningConfig, type MakeMeaningRecord } from '../service';
import { createTestProject } from './helpers/test-project';
import { stubEmbeddingProbeFetch } from './helpers/smelter-harness';

stubEmbeddingProbeFetch();

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

// Deliberately names the jetstream driver at an unreachable address: a record
// root that HONORED `[services.jobs]` would dial a broker and open a consumer,
// hanging this test (10s connect timeout) instead of resolving. The contract
// is that the record root never looks at the section at all.
const config: MakeMeaningConfig = {
  gather: { settleTimeoutMs: 15_000 },
  search: { semanticFloor: 0.6 },
  services: {
    graph: { platform: { type: 'posix' }, type: 'memory' },
    vectors: { type: 'memory' },
    embedding: { type: 'ollama', model: 'nomic-embed-text' },
    jobs: { type: 'jetstream', servers: '127.0.0.1:1' },
  },
  actors: {
    gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
    matcher: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
  },
  workers: { default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' } },
};

// The worker LEASE + enqueue surface a job queue's handlers subscribe, plus
// the status responder. The record root hosts none of them.
const JOB_CHANNELS = [
  'job:create', 'job:claim', 'job:cancel-requested',
  'job:report-progress', 'job:complete', 'job:fail',
  'job:status-requested',
] as const;

describe('connectRecord (record-maintenance root: no jobs, no broker)', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let bus: EventBus;
  let record: MakeMeaningRecord;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ project, teardown } = await createTestProject('connect-record'));
    bus = new EventBus();
    record = await connectRecord(project, config, bus, silentLogger);
  }, 30_000);

  afterEach(async () => {
    await record?.stop();
    bus?.destroy();
    await teardown?.();
  });

  it('exposes the event store for query + materialization', () => {
    expect(record.eventStore).toBeDefined();
    expect(record.eventStore.log.storage).toBeDefined();
    expect(typeof record.eventStore.views.materializer.materialize).toBe('function');
  });

  it('subscribes to NO job-command channels: it dispatches nothing, so it hosts no queue', () => {
    const observed = new Set(bus.observedChannels());
    const leaked = JOB_CHANNELS.filter((c) => observed.has(c));
    expect(leaked).toEqual([]);
  });
});
