/**
 * Root-parity gate: the in-process composition root keeps pace with the
 * extracted services.
 *
 * Two compositions of the same actor fleet exist — the extracted mains
 * (archivist-main, librarian-main; production) and `startMakeMeaning`
 * (in-process; the SDK test seam and embedding). The extracted mains build
 * their subscriptions from the exported roster constants; this gate asserts
 * the in-process root observes the union of those same constants, so a
 * change that adds a channel or an actor cannot reach the mains while the
 * in-process root silently lags — with LocalTransport tests staying green
 * against wiring production does not have.
 *
 * The union deliberately EXCLUDES the projection pipelines: the Weaver and
 * Smelter are standalone-only (constructed in their mains, never here), so
 * their channels are not this root's obligation.
 * Nor does it run jobs: the job queue is the dispatcher's, a process of its
 * own, and this root answers none of its operations. (The Stower here still
 * records the lifecycle a worker reports, as it does in the Archivist.)
 *
 * Per-actor channel fidelity (roster constant == the actor's real
 * subscriptions) is pinned by each actor's own census gate; this gate adds
 * only the root-level claim: every rostered actor and handler is actually
 * composed here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startMakeMeaning, type MakeMeaningService, type MakeMeaningConfig } from '../service';
import { STOWER_CHANNELS, BROWSER_CHANNELS, CLONE_TOKEN_CHANNELS, MATCHER_CHANNELS, GATHERER_CHANNELS } from '../service-channels';
import { HANDLER_CHANNELS } from '../handlers/index.js';
import { SemiontProject } from '@semiont/core/node';
import { BUS_OPERATIONS, EventBus, type Logger } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { stubEmbeddingProbeFetch } from './helpers/smelter-harness';
import { declareTestKb } from './helpers/test-project';

stubEmbeddingProbeFetch();

const silentLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const ROSTERS: Record<string, readonly string[]> = {
  stower: STOWER_CHANNELS,
  browser: BROWSER_CHANNELS,
  cloneTokenManager: CLONE_TOKEN_CHANNELS,
  matcher: MATCHER_CHANNELS,
  gatherer: GATHERER_CHANNELS,
  handlers: HANDLER_CHANNELS,
};

describe('root parity (in-process composition root vs extracted rosters)', () => {
  let testDir: string;
  let project: SemiontProject;
  let service: MakeMeaningService;
  let eventBus: EventBus;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-root-parity-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    await declareTestKb(testDir);
    project = new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` });
    eventBus = new EventBus();

    const config: MakeMeaningConfig = {
      gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 },
      services: {
        graph: { platform: { type: 'posix' }, type: 'memory' },
        vectors: { type: 'memory' },
        embedding: { type: 'ollama', model: 'nomic-embed-text' },
      },
      actors: {
        gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
        matcher: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
      workers: {
        default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
    };
    service = await startMakeMeaning(project, config, eventBus, silentLogger);
  });

  afterAll(async () => {
    await service?.stop();
    eventBus?.destroy();
    await project?.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('observes every channel in the union of the extracted rosters', () => {
    const observed = new Set(eventBus.observedChannels());

    // Sanity: the boot subscribed SOMETHING — a vacuous pass here would mean
    // the accessor or the boot broke, not that parity holds.
    expect(observed.size).toBeGreaterThan(0);

    const missing: Record<string, string[]> = {};
    for (const [roster, channels] of Object.entries(ROSTERS)) {
      const gone = channels.filter((c) => !observed.has(c));
      if (gone.length > 0) missing[roster] = gone;
    }

    // A non-empty entry means an actor or handler the extracted services
    // compose is absent (or deaf) in the in-process root — fix the root, or
    // if the channel genuinely left the fleet, fix its roster constant.
    expect(missing).toEqual({});
  });

  it('answers no job operation: the queue is the dispatcher\'s', () => {
    const jobOperations = Object.keys(BUS_OPERATIONS).filter((c) => c.startsWith('job:'));
    expect(jobOperations.length).toBeGreaterThan(0);
    const observed = new Set(eventBus.observedChannels());
    expect(jobOperations.filter((c) => observed.has(c))).toEqual([]);
  });
});
