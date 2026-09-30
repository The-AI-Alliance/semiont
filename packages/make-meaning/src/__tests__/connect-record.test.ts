/**
 * connectRecord — the actor-less record-maintenance root. The
 * `rebuild-projections` CLI reads the event log and re-materializes views, and
 * nothing more: the root it uses connects the stores and exposes the record.
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

describe('connectRecord (record-maintenance root)', () => {
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
});
