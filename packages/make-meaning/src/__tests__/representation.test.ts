/**
 * SINGLE-KB-MOUNT P3 — the ONE resolution of `resourceId → (bytes, mediaType)`.
 *
 * Before this phase the join was written out five times (the plan's table),
 * with three different answers to "what type is this when the record doesn't
 * say" and two different opinions about which field holds the URI. One of the
 * five was already wrong: `LocalContentTransport.loadBinary` read
 * `representations[].storageUri`, which `ViewMaterializer` never writes — so
 * `getBinary` threw for every resource in local mode, uncaught because nothing
 * exercised it.
 *
 * These tests pin the collapse: one decision, one fallback, and every face
 * agreeing — asserted against real storage, because the bug that hid here was
 * exactly a disagreement between a view's shape and a reader's assumption.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { resourceId as makeResourceId, userId, type Logger, type ResourceDescriptor } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { EventBus } from '@semiont/core';
import { WorkingTreeStore } from '@semiont/content';
import { RepresentationMissing } from '@semiont/content';
import { representationSource, resolveRepresentation } from '../representation';
import { workingTreeContentReads } from '../knowledge-base';
import { createTestProject, type TestProject } from './helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const BODY = 'the stored bytes';
const URI = 'file://docs/note.md';

describe('representationSource — the one decision', () => {
  it('reads the URI from the field the materializer actually writes', () => {
    // Top-level `storageUri` is the only one ViewMaterializer populates; the
    // representation carries mediaType/checksum/byteSize and no URI.
    const resource = {
      storageUri: URI,
      representations: [{ mediaType: 'text/markdown', checksum: 'abc' }],
    } as unknown as ResourceDescriptor;

    expect(representationSource(resource)).toEqual({ storageUri: URI, mediaType: 'text/markdown' });
  });

  it('falls back to octet-stream once, for a representation-less descriptor', () => {
    const resource = { storageUri: URI } as unknown as ResourceDescriptor;
    expect(representationSource(resource)?.mediaType).toBe('application/octet-stream');
  });

  it('is null when there is no URI — the has-content signal, not an error', () => {
    expect(representationSource({ representations: [{ mediaType: 'text/plain' }] } as unknown as ResourceDescriptor)).toBeNull();
    expect(representationSource(undefined)).toBeNull();
  });
});

describe('resolveRepresentation — every face agrees', () => {
  let tp: TestProject;
  let eventBus: EventBus;
  let eventStore: EventStore;
  let content: WorkingTreeStore;
  let rid: ReturnType<typeof makeResourceId>;

  beforeEach(async () => {
    tp = await createTestProject('representation');
    eventBus = new EventBus();
    eventStore = createEventStore(tp.project, eventBus, mockLogger);
    content = new WorkingTreeStore(tp.project, mockLogger);

    await content.store(Buffer.from(BODY), URI, { noGit: true });
    rid = makeResourceId('res-rep');
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: rid,
      userId: userId('user-rep'),
      version: 1,
      payload: {
        name: 'Note',
        format: 'text/markdown',
        contentChecksum: 'h1',
        storageUri: URI,
      },
    });
  });

  afterEach(async () => {
    eventBus.destroy();
    await tp.teardown();
  });

  const deps = () => ({ views: eventStore.viewStorage, content });

  it('streams the bytes with the stored media type', async () => {
    const { stream, mediaType } = await resolveRepresentation(deps(), rid);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe(BODY);
    expect(mediaType).toBe('text/markdown');
  });

  it('distinguishes an unknown resource from one with no representation', async () => {
    const unknown = await resolveRepresentation(deps(), makeResourceId('res-nope')).catch((e) => e);
    expect(unknown).toBeInstanceOf(RepresentationMissing);
    expect((unknown as RepresentationMissing).reason).toBe('resource');

    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: makeResourceId('res-bodiless'),
      userId: userId('user-rep'),
      version: 1,
      payload: { name: 'Bodiless', format: 'text/plain', contentChecksum: 'h2' },
    });
    const bodiless = await resolveRepresentation(deps(), makeResourceId('res-bodiless')).catch((e) => e);
    expect(bodiless).toBeInstanceOf(RepresentationMissing);
    expect((bodiless as RepresentationMissing).reason).toBe('representation');
  });

  it('workingTreeContentReads is a buffering face of the same call', async () => {
    const { data, contentType } = await workingTreeContentReads(eventStore.viewStorage, content).getBinary(rid);

    expect(Buffer.from(data).toString()).toBe(BODY);
    expect(contentType).toBe('text/markdown');
  });

  it('LocalContentTransport.getBinary works — it read a field nobody writes', async () => {
    // The bug the collapse fixes: `loadBinary` resolved through
    // `getPrimaryRepresentation(...).storageUri`, which ViewMaterializer never
    // populates, so this threw for EVERY resource in local mode.
    const { LocalContentTransport } = await import('../local-content-transport');
    // Still a cast, but a far smaller lie: a two-field stand-in for a
    // KnowledgeBase, which is all `getBinary` reads. It used to have to stand
    // in for a whole KnowledgeSystem — five actors this code never touches.
    const transport = new LocalContentTransport(
      { views: eventStore.viewStorage, content } as never,
    );

    const { data, contentType } = await transport.getBinary(rid);
    expect(Buffer.from(data).toString()).toBe(BODY);
    expect(contentType).toBe('text/markdown');
  });

  it('the store streams a read without buffering the whole file', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x41);
    await content.store(big, 'file://big.bin', { noGit: true });

    const stream = content.retrieveStream('file://big.bin');
    let seen = 0;
    let chunks = 0;
    for await (const chunk of stream) { seen += (chunk as Buffer).length; chunks++; }

    expect(seen).toBe(big.length);
    // Streaming means more than one chunk for a multi-megabyte file; a single
    // chunk would mean it was read whole and handed over.
    expect(chunks).toBeGreaterThan(1);
  });

  it('a missing file is a stream error, not a silent empty body', async () => {
    await fs.rm(tp.project.root + '/docs/note.md');
    const failed = await (async () => {
      try {
        const { stream } = await resolveRepresentation(deps(), rid);
        for await (const _ of stream) { /* drain */ }
        return null;
      } catch (error) { return error; }
    })();

    expect(failed).toBeInstanceOf(Error);
  });
});
