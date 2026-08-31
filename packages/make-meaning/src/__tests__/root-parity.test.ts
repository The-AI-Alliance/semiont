/**
 * Root-parity gate: the in-process composition root keeps pace with the
 * extracted services.
 *
 * Two compositions of the same actor fleet exist — the extracted mains
 * (archivist-main, librarian-main; production) and `startMakeMeaning`
 * (in-process; the SDK test seam and embedding, DECIDED to survive —
 * GATEWAY.md open item 1, 2026-08-31). The extracted mains build their
 * subscriptions from the exported roster constants; this gate asserts the
 * in-process root observes the union of those same constants, so an
 * extraction-era change that adds a channel or an actor cannot land in the
 * mains while the monolith root silently lags — with LocalTransport tests
 * staying green against wiring production no longer has.
 *
 * The union deliberately EXCLUDES the projection pipelines: the Weaver and
 * Smelter are standalone-only (WEAVER-ISOLATION D4; constructed in their
 * mains, never here), so their channels are not this root's obligation.
 *
 * Per-actor channel fidelity (roster constant == the actor's real
 * subscriptions) is pinned by each actor's own census gate; this gate adds
 * only the root-level claim: every rostered actor and handler is actually
 * composed here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startMakeMeaning, type MakeMeaningService, type MakeMeaningConfig } from '../service';
import { STOWER_CHANNELS } from '../stower';
import { BROWSER_CHANNELS } from '../browser';
import { CLONE_TOKEN_CHANNELS } from '../clone-token-manager';
import { MATCHER_CHANNELS } from '../matcher';
import { GATHERER_CHANNELS } from '../gatherer';
import { HANDLER_CHANNELS } from '../handlers/index.js';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { stubEmbeddingProbeFetch } from './helpers/smelter-harness';

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
});
