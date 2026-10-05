/**
 * A history reply says who did each thing.
 *
 * An event names its actor by DID and nothing else. The Browser makes the
 * agent on the way out — the DID read into a Person or a Software agent, a
 * Person's name filled in from the people projection — so a reader of a
 * resource's history is told who acted, by the one resolver every other reply
 * goes through. Nothing is written back: the log holds the DID alone.
 *
 * These run the whole service on a real knowledge base. The reply is what a
 * client receives, and the log is read afterwards to show it is unchanged.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { SemiontProject } from '@semiont/core/node';
import {
  EventBus, ResourceOperations, agentToDid, annotationId, busRequest, deriveStorageUri, resourceId, userToDid,
  type AnnotationId, type Logger, type ResourceId, type UserId,
} from '@semiont/core';
import { asBusRequestPrimitive } from '..';
import { AnnotationOperations } from '../archivist/annotation-operations';
import { composeArchivist, type Archivist } from '../archivist/compose';
import { readPeopleProjection } from '../views/people-reader';
import { stubEmbeddingProbeFetch } from './helpers/smelter-harness';
import { declareTestKb, TEST_KB_DOMAIN } from './helpers/test-project';

stubEmbeddingProbeFetch();

const mockLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

/** A person the knowledge base has a name for. */
const ALICE = userToDid({ domain: TEST_KB_DOMAIN, subject: '59523dd4-a0e3-4c1c-8c2d-7fcbe3d789dd' });
/** A person it has none for: nothing ever recorded what they are called. */
const BOB = userToDid({ domain: TEST_KB_DOMAIN, subject: '8b1f0c22-77aa-4d31-9b0e-1c2d3e4f5a6b' });
/** A software peer. */
const WORKER = agentToDid({ domain: TEST_KB_DOMAIN, provider: 'anthropic', model: 'claude-haiku-4-5' });

describe('history replies name their actors', () => {
  let testDir: string;
  let project: SemiontProject;
  let eventBus: EventBus;
  let archivist: Archivist;
  let rId: ResourceId;
  /** Bob's highlight, which the worker then adds to. */
  let annotated: AnnotationId;

  const highlight = async (start: number, end: number, by: UserId): Promise<AnnotationId> => {
    const { annotation } = await AnnotationOperations.createAnnotation(
      { motivation: 'highlighting', target: { source: rId, selector: [{ type: 'TextPositionSelector', start, end }] }, body: [] },
      by,
      eventBus,
      archivist,
    );
    await firstValueFrom(eventBus.on('mark:added').pipe(filter((e) => e.payload.annotation.id === annotation.id), take(1)));
    return annotationId(annotation.id);
  };

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-browse-history-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    await declareTestKb(testDir);
    project = new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` });
    archivist = await composeArchivist(project, {}, mockLogger, { skipRebuild: false });
    eventBus = archivist.bus;
    const kb = archivist;

    // The gateway publishes a person's verified name when they act. Alice's is
    // recorded; Bob's never is.
    eventBus.emit('person:profile', { name: 'Adam Pingel', _userId: ALICE });
    await vi.waitFor(async () => {
      expect(await readPeopleProjection(project)).toHaveProperty([ALICE]);
    });

    const stored = await kb.content.store(Buffer.from('A text with two passages worth marking.'), deriveStorageUri('history', 'text/plain'));
    rId = resourceId(await ResourceOperations.createResource(
      { name: 'History', storageUri: stored.storageUri, contentChecksum: stored.checksum, byteSize: stored.byteSize, format: 'text/plain' },
      { did: ALICE, roles: [] },
      asBusRequestPrimitive(eventBus),
    ));

    annotated = await highlight(2, 6, BOB);
    await highlight(16, 24, ALICE);

    const updated = firstValueFrom(eventBus.on('mark:body-updated').pipe(take(1)));
    await AnnotationOperations.updateAnnotationBody(
      annotated,
      { resourceId: rId, operations: [{ op: 'add', item: { type: 'TextualBody', value: 'worth a second look', purpose: 'commenting' } }] },
      WORKER,
      eventBus,
      kb,
    );
    await updated;
  });

  afterAll(async () => {
    await archivist.stop();
    eventBus.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const events = async () =>
    (await busRequest(asBusRequestPrimitive(eventBus), 'browse:events-requested', { resourceId: rId }, 10_000)).events;

  const history = async () =>
    busRequest(asBusRequestPrimitive(eventBus), 'browse:annotation-history-requested', { resourceId: rId, annotationId: annotated }, 10_000);

  describe("a resource's events", () => {
    it('names a person the knowledge base has a name for', async () => {
      const created = (await events()).find((e) => e.type === 'yield:created');
      expect(created?.agent).toEqual({ '@type': 'Person', '@id': ALICE, name: 'Adam Pingel' });
    });

    it('leaves a person it has no name for unnamed', async () => {
      const added = (await events()).find((e) => e.type === 'mark:added' && e.userId === BOB);
      expect(added?.agent).toEqual({ '@type': 'Person', '@id': BOB });
    });

    it('reads a software peer from its DID', async () => {
      const updated = (await events()).find((e) => e.type === 'mark:body-updated');
      expect(updated?.agent).toEqual({
        '@type': 'Software', '@id': WORKER, name: 'anthropic claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5',
      });
    });

    it('gives every event the agent its own userId identifies', async () => {
      const all = await events();
      expect(all.length).toBeGreaterThanOrEqual(4);
      for (const event of all) {
        expect(event.agent['@id'], `${event.type} by ${event.userId}`).toBe(event.userId);
      }
    });

    it('carries each event as the log holds it: a name goes on the agent, never into a payload', async () => {
      // Alice has a name, and her highlight's stored annotation says she made
      // it. The Weaver rebuilds the graph from this reply, so a name written
      // into the payload here would be a name written into the graph.
      const logged = await archivist.eventStore.log.getEvents(rId);
      const reply = await events();
      const hers = reply.find((e) => e.type === 'mark:added' && e.userId === ALICE);
      expect(hers?.agent.name).toBe('Adam Pingel');
      expect(hers?.payload).toEqual(logged.find((e) => e.id === hers?.id)?.payload);
      expect(reply.map(({ agent: _agent, ...stored }) => stored)).toEqual(logged);
    });

    it('writes no agent and no name into the log', async () => {
      await events();
      const logged = await archivist.eventStore.log.getEvents(rId);
      expect(logged.length).toBeGreaterThanOrEqual(4);
      for (const event of logged) {
        expect(event).not.toHaveProperty('agent');
      }
    });
  });

  describe("an annotation's history", () => {
    it("holds that annotation's events, in order, and no other annotation's", async () => {
      const reply = await history();
      expect(reply.events.map((e) => e.type)).toEqual(['mark:added', 'mark:body-updated']);
      expect(reply.total).toBe(2);
    });

    it('names their actors as the events reply does', async () => {
      const [added, updated] = (await history()).events;
      expect(added?.agent).toEqual({ '@type': 'Person', '@id': BOB });
      expect(updated?.agent['@type']).toBe('Software');
      expect(updated?.agent['@id']).toBe(WORKER);
    });
  });
});
