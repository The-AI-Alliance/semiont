/**
 * CloneTokenManager — format selection on clone-create.
 *
 * A clone opens in the compose editor, so the format gate is the registry's
 * `authorable` capability (MEDIA-TYPES.md Phase 5): authorable sources keep
 * their base media type; everything else falls back to text/plain. Pins the
 * fix for the stale ['text/plain', 'text/markdown'] allowlist that wrongly
 * coerced text/html clones to text/plain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, race, timeout, filter, map } from 'rxjs';
import { SemiontProject } from '@semiont/core/node';
import {
  EventBus,
  type Logger,
  type SupportedMediaType,
  userId,
  resourceId as makeResourceId,
  getPrimaryRepresentation,
} from '@semiont/core';
import { deriveStorageUri } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { startMakeMeaning, ResourceOperations, ResourceContext, type MakeMeaningConfig } from '..';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

let fileCounter = 0;

describe('CloneTokenManager format selection', () => {
  let testDir: string;
  let makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
  let eventBus: EventBus;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-ctm-test-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    const project = new SemiontProject(testDir);

    const config: MakeMeaningConfig = {
      gather: { settleTimeoutMs: 15_000 },
      services: {
        graph: { platform: { type: 'posix' }, type: 'memory' },
      },
      actors: {
        gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
        matcher: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
      workers: {
        default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
    };

    eventBus = new EventBus();
    makeMeaning = await startMakeMeaning(project, config, eventBus, mockLogger);
  });

  afterEach(async () => {
    if (makeMeaning) {
      await makeMeaning.stop();
    }
    if (eventBus) {
      eventBus.destroy();
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function createSource(format: SupportedMediaType, content: string) {
    const kb = makeMeaning.knowledgeSystem.kb;
    const uri = deriveStorageUri(`clone-src-${++fileCounter}`, format);
    const stored = await kb.content.store(Buffer.from(content), uri);
    return ResourceOperations.createResource(
      { name: `source-${fileCounter}`, storageUri: stored.storageUri, contentChecksum: stored.checksum, byteSize: stored.byteSize, format },
      userId('ctm-test'),
      eventBus,
    );
  }

  /** Run the full clone flow against a source of the given format; return the clone's mediaType. */
  async function cloneFormat(sourceFormat: SupportedMediaType, content: string): Promise<string | undefined> {
    const sourceId = await createSource(sourceFormat, content);

    const tokenCid = uuidv4();
    const token$ = firstValueFrom(
      race(
        eventBus.get('yield:clone-token-generated').pipe(
          filter((e) => e.correlationId === tokenCid),
          map((e) => e.response.token),
        ),
        eventBus.get('yield:clone-token-failed').pipe(
          filter((e) => e.correlationId === tokenCid),
          map((e) => {
            throw new Error(e.message);
          }),
        ),
      ).pipe(timeout(5000)),
    );
    eventBus.get('yield:clone-token-requested').next({ correlationId: tokenCid, resourceId: sourceId });
    const token = await token$;

    const createCid = uuidv4();
    const created$ = firstValueFrom(
      race(
        eventBus.get('yield:clone-created').pipe(
          filter((e) => e.correlationId === createCid),
          map((e) => e.response.resourceId),
        ),
        eventBus.get('yield:clone-create-failed').pipe(
          filter((e) => e.correlationId === createCid),
          map((e) => {
            throw new Error(e.message);
          }),
        ),
      ).pipe(timeout(5000)),
    );
    eventBus.get('yield:clone-create').next({
      correlationId: createCid,
      token,
      name: `clone-${fileCounter}`,
      content: 'edited clone content',
      _userId: 'ctm-test',
    });
    const cloneId = await created$;
    if (!cloneId) throw new Error('yield:clone-created carried no resourceId');

    const clone = await ResourceContext.getResourceMetadata(makeResourceId(cloneId), makeMeaning.knowledgeSystem.kb);
    expect(clone).not.toBeNull();
    return getPrimaryRepresentation(clone!)?.mediaType;
  }

  it('clones an authorable source with its own format (text/html)', async () => {
    expect(await cloneFormat('text/html', '<p>source</p>')).toBe('text/html');
  });

  it('falls back to text/plain for a registered but non-authorable source (application/json)', async () => {
    expect(await cloneFormat('application/json', '{"source":true}')).toBe('text/plain');
  });

  it('falls back to text/plain for a binary source (image/png)', async () => {
    expect(await cloneFormat('image/png', 'not real png bytes')).toBe('text/plain');
  });
});
