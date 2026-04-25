/**
 * Integration test: SemiontClient over LocalTransport.
 *
 * Boots a real KnowledgeSystem with `startMakeMeaning`, wraps it with
 * `LocalTransport` + `LocalContentTransport`, constructs a real
 * `SemiontClient`, and exercises a round-trip:
 *
 *   client.browseResources()
 *     → LocalTransport.emit('browse:resources-requested', …) on make-meaning bus
 *     → Browser actor handles it, emits 'browse:resources-result'
 *     → LocalTransport.stream('browse:resources-result') receives it
 *     → busRequest correlation matches → promise resolves
 *
 * If any link in that chain is broken, the test hangs (timeout) or fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

import { SemiontProject } from '@semiont/core/node';
import { EventBus, userDID, type Logger } from '@semiont/core';
import { SemiontClient } from '@semiont/api-client';

import { startMakeMeaning, type MakeMeaningService, type MakeMeaningConfig } from '../service';
import { LocalTransport } from '../local-transport';
import { LocalContentTransport } from '../local-content-transport';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

describe('LocalTransport integration', () => {
  let testDir: string;
  let project: SemiontProject;
  let config: MakeMeaningConfig;
  let eventBus: EventBus;
  let service: MakeMeaningService | null = null;
  let client: SemiontClient | null = null;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-local-transport-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    project = new SemiontProject(testDir);

    eventBus = new EventBus();

    config = {
      services: {
        graph: { platform: { type: 'posix' }, type: 'memory' },
      },
      actors: {
        gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
        matcher:  { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
      workers: {
        default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
    };
  });

  afterEach(async () => {
    if (client) {
      client.dispose();
      client = null;
    }
    if (service) {
      await service.stop();
      service = null;
    }
    if (eventBus) {
      eventBus.destroy();
    }
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('round-trips browseResources() through the make-meaning bus', async () => {
    service = await startMakeMeaning(project, config, eventBus, mockLogger);

    const transport = new LocalTransport({
      knowledgeSystem: service.knowledgeSystem,
      eventBus,
      userId: userDID('did:semiont:test-host'),
    });
    const content = new LocalContentTransport(service.knowledgeSystem);
    client = new SemiontClient(transport, content);

    const result = await client.browseResources();

    expect(result).toBeDefined();
    expect(Array.isArray(result.resources)).toBe(true);
    expect(result.resources).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('bridges bus events from make-meaning bus into client.bus', async () => {
    service = await startMakeMeaning(project, config, eventBus, mockLogger);

    const transport = new LocalTransport({
      knowledgeSystem: service.knowledgeSystem,
      eventBus,
      userId: userDID('did:semiont:test-host'),
    });
    const content = new LocalContentTransport(service.knowledgeSystem);
    client = new SemiontClient(transport, content);

    // Subscribe to a bridged channel on the *client's* bus and verify a
    // make-meaning-bus emit reaches us via the transport bridge.
    const received: unknown[] = [];
    const sub = (
      client.bus.get('browse:resources-result') as unknown as {
        subscribe(fn: (v: unknown) => void): { unsubscribe(): void };
      }
    ).subscribe((v) => received.push(v));

    // Trigger the round-trip: Browser actor will publish 'browse:resources-result'
    // on the make-meaning bus, and the LocalTransport bridge forwards it to client.bus.
    await client.browseResources();

    expect(received.length).toBeGreaterThan(0);
    sub.unsubscribe();
  });
});
