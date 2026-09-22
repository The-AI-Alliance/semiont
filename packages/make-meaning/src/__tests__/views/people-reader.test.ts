/**
 * People Projection Reader Tests
 *
 * The read side of PERSON-PROFILE. Mirrors `tag-schemas-reader.test.ts`:
 * reading an existing projection, the missing-file case, and — the
 * load-bearing one — the round trip from a bus command through the Stower,
 * the event store and the materializer to what the reader serves back.
 *
 * The properties this pins are the ones the design rests on: a rename
 * REPLACES rather than accumulates (so a reader sees the current name, and a
 * correction reaches every artifact its subject ever wrote), and a DID with
 * no profile stays unnamed rather than acquiring a fabricated one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readPeopleProjection, resolvePersonNames } from '../../views/people-reader';
import { createEventStore, type PeopleView } from '@semiont/event-sourcing';
import { type SemiontProject } from '@semiont/core/node';
import {
  EventBus,
  type Logger,
  type GraphServiceConfig,
  userId as makeUserId,
} from '@semiont/core';
import { createKnowledgeBase } from '../../knowledge-base';
import { Stower } from '../../stower';
import { getGraphDatabase } from '@semiont/graph';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createTestProject } from '../helpers/test-project';
import { createVectorStore } from '@semiont/vectors';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const ALICE = 'did:web:test:users:59523dd4-a0e3-4c1c-8c2d-7fcbe3d789dd';

describe('People Projection Reader', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('people-reader'));
  });

  afterEach(async () => {
    await teardown();
  });

  it('returns the people from an existing projection file', async () => {
    await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
    await fs.writeFile(
      join(project.stateDir, 'projections', '__system__', 'people.json'),
      JSON.stringify({ people: { [ALICE]: { name: 'Adam Pingel', since: '2026-09-22T10:00:00.000Z' } } }),
    );

    expect(await readPeopleProjection(project)).toEqual({
      [ALICE]: { name: 'Adam Pingel', since: '2026-09-22T10:00:00.000Z' },
    });
  });

  it('returns an empty map when no profile has ever been recorded', async () => {
    // Not an error and not a fabricated name: a knowledge base whose people
    // have not acted yet simply knows nothing about them.
    expect(await readPeopleProjection(project)).toEqual({});
  });

  describe('resolvePersonNames', () => {
    const people: PeopleView = { [ALICE]: { name: 'Adam Pingel', since: '2026-09-22T10:00:00.000Z' } };

    it('names a Person the record identified but did not name', () => {
      const reply = { annotations: [{ id: 'a1', creator: { '@type': 'Person', '@id': ALICE } }] };

      expect(resolvePersonNames(reply, people).annotations[0]!.creator).toEqual({
        '@type': 'Person', '@id': ALICE, name: 'Adam Pingel',
      });
    });

    it('OVERRIDES a stored name — an artifact written before this existed reads correctly', () => {
      // The whole benefit of resolving on read: artifacts written when
      // didToAgent filled the subject carry a UUID where a name belongs, and
      // there is nothing to backfill because nothing is authoritative there.
      const old = { creator: { '@type': 'Person', '@id': ALICE, name: '59523dd4-a0e3-4c1c-8c2d-7fcbe3d789dd' } };

      expect(resolvePersonNames(old, people).creator.name).toBe('Adam Pingel');
    });

    it('leaves a DID it has no profile for unnamed', () => {
      const reply = { creator: { '@type': 'Person', '@id': 'did:web:test:users:stranger' } };

      expect(resolvePersonNames(reply, people).creator).not.toHaveProperty('name');
    });

    it('does not touch a Software agent — its name comes from provider and model', () => {
      const reply = { generator: { '@type': 'Software', '@id': ALICE, name: 'ollama gemma' } };

      expect(resolvePersonNames(reply, people).generator.name).toBe('ollama gemma');
    });

    it('reaches every Agent, whatever shape holds it', () => {
      // Agents appear as a field, inside arrays, and nested under a
      // descriptor. Listing those paths by hand is the mirror this walk
      // exists to avoid — the next reply shape is covered without an edit.
      const reply = {
        resources: [{ wasAttributedTo: [{ '@type': 'Person', '@id': ALICE }, { '@type': 'Software', '@id': 'did:web:t:agents:o:g', name: 'o g' }] }],
        deep: { nested: { creator: { '@type': 'Person', '@id': ALICE } } },
      };

      const out = resolvePersonNames(reply, people);
      expect((out.resources[0]!.wasAttributedTo[0] as { name?: string }).name).toBe('Adam Pingel');
      expect((out.deep.nested.creator as { name?: string }).name).toBe('Adam Pingel');
    });

    it('returns the same reference when nothing changed', () => {
      const reply = { annotations: [{ id: 'a1', body: 'no agents here' }] };

      expect(resolvePersonNames(reply, people)).toBe(reply);
    });
  });

  describe('integration with Stower.handlePersonProfile', () => {
    // The load-bearing test: emitting the command must produce a projection
    // the reader serves back. If this fails while the unit tests pass, the
    // wiring between Stower / event store / ViewMaterializer / projection
    // file is broken.
    it('reads the name after the Stower handles a person:profile, and a rename REPLACES it', async () => {
      const eventBus = new EventBus();
      const eventStore = createEventStore(project, eventBus, mockLogger);
      const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
      const kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, mockLogger, { vectorStore: await createVectorStore({ type: 'memory', dimensions: async () => 4 }) });
      const stower = new Stower(kb, eventBus, project, mockLogger);
      await stower.initialize();

      expect(await readPeopleProjection(project)).toEqual({});

      const profile = async (name: string, until: (v: PeopleView) => boolean) => {
        // Driven through the bus the way the gateway drives it; `_userId` is
        // the injection the gateway performs from the verified token.
        eventBus.emit('person:profile', { name, _userId: makeUserId(ALICE) } as never);
        let view: PeopleView = {};
        for (let i = 0; i < 50; i++) {
          view = await readPeopleProjection(project);
          if (until(view)) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        return view;
      };

      const first = await profile('Adma Pingel', (v) => v[ALICE]?.name === 'Adma Pingel');
      expect(first[ALICE]?.name).toBe('Adma Pingel');
      expect(typeof first[ALICE]?.since).toBe('string');

      // The typo is corrected at the issuer. One new event, and the
      // projection holds one entry — not two, and not the old name.
      const second = await profile('Adam Pingel', (v) => v[ALICE]?.name === 'Adam Pingel');
      expect(second[ALICE]?.name).toBe('Adam Pingel');
      expect(Object.keys(second), 'a rename is not a second person').toEqual([ALICE]);

      await stower.stop();
      eventBus.destroy();
    });
  });
});
