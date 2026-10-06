/**
 * People Projection Reader Tests
 *
 * The read side of a person's recorded name: reading the projection the
 * Archivist keeps, the missing-file case, and resolving names into a reply.
 * A DID with no profile stays unnamed rather than acquiring a fabricated one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readPeopleProjection, resolvePersonNames, type People } from '../../views/people-reader';
import { createRecordFixture, writePeople, type RecordFixture } from '../helpers/record-fixtures';

const ALICE = 'did:web:test:users:59523dd4-a0e3-4c1c-8c2d-7fcbe3d789dd';

describe('People Projection Reader', () => {
  let record: RecordFixture;

  beforeEach(async () => {
    record = await createRecordFixture();
  });

  afterEach(async () => {
    await record.teardown();
  });

  it('returns the people from an existing projection file', async () => {
    await writePeople(record.stateDir, { [ALICE]: { name: 'Adam Pingel', since: '2026-09-22T10:00:00.000Z' } });

    expect(await readPeopleProjection(record)).toEqual({
      [ALICE]: { name: 'Adam Pingel', since: '2026-09-22T10:00:00.000Z' },
    });
  });

  it('returns an empty map when no profile has ever been recorded', async () => {
    // Not an error and not a fabricated name: a knowledge base whose people
    // have not acted yet simply knows nothing about them.
    expect(await readPeopleProjection(record)).toEqual({});
  });

  describe('resolvePersonNames', () => {
    const people: People = { [ALICE]: { name: 'Adam Pingel', since: '2026-09-22T10:00:00.000Z' } };

    it('names a Person the record identified but did not name', () => {
      const reply = { annotations: [{ id: 'a1', creator: { '@type': 'Person', '@id': ALICE } }] };

      expect(resolvePersonNames(reply, people).annotations[0]!.creator).toEqual({
        '@type': 'Person', '@id': ALICE, name: 'Adam Pingel',
      });
    });

    it('OVERRIDES a stored name — an artifact carrying a UUID where a name belongs reads correctly', () => {
      // The whole benefit of resolving on read: some stored artifacts carry
      // the subject UUID where a name belongs, and there is nothing to
      // backfill because nothing is authoritative there.
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
});
