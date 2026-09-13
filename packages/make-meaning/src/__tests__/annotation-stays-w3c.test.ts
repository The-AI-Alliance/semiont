/**
 * An `Annotation` on the wire is exactly the W3C annotation its author wrote
 * (ANNOTATIONS-STAY-W3C D1).
 *
 * The server used to staple `_resolvedDocumentName` and
 * `_resolvedDocumentMediaType` onto linking annotations on the way out — a
 * lookup result wearing the shape of an authored fact. It went unnoticed for
 * as long as it did because nothing could catch it: the fields were never in
 * the spec, so `tsc` saw a cast on the reader's side and the request validator
 * saw a schema with no `additionalProperties: false` to violate.
 *
 * So the guard is a test, and its allowed set is DERIVED from the spec rather
 * than restated here. A hand-written key list would be a second answer to
 * "what is an Annotation", and the next field added to the schema would make
 * this gate wrong rather than the code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { EventBus, annotationId, resourceId, userId, type Annotation } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { AnnotationContext } from '../annotation-context';
import { createTestProject, type TestProject } from './helpers/test-project';
import { mockLogger } from './helpers/smelter-harness';

/**
 * The keys the spec declares. Read from the schema file, so this cannot drift
 * from it: add a property there and it is allowed here the same day.
 */
const SPEC_KEYS: ReadonlySet<string> = (() => {
  const here = join(fileURLToPath(import.meta.url), '..');
  const schema = JSON.parse(
    readFileSync(join(here, '../../../../specs/src/components/schemas/Annotation.json'), 'utf8'),
  ) as { properties: Record<string, unknown> };
  return new Set(Object.keys(schema.properties));
})();

/** Every key on `annotation` that the spec does not declare. */
function undeclaredKeys(annotation: Annotation): string[] {
  return Object.keys(annotation).filter((k) => !SPEC_KEYS.has(k));
}

const SOURCE = resourceId('res-w3c-source');
const TARGET = resourceId('res-w3c-target');
const USER = userId('did:web:test:users:test');

describe('annotations carry only what the spec declares', () => {
  let tp: TestProject;
  let eventStore: EventStore;
  let bus: EventBus;

  beforeEach(async () => {
    tp = await createTestProject('annotation-stays-w3c');
    bus = new EventBus();
    eventStore = createEventStore(tp.project, bus, mockLogger);

    // Two resources: the target must EXIST and be named, because that is the
    // only case the enricher fired on. A gate run against a missing target
    // would pass while the defect sat untouched.
    for (const [rid, name] of [[SOURCE, 'Source doc'], [TARGET, 'Target doc']] as const) {
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: rid, userId: USER, version: 1,
        payload: { name, format: 'text/plain', contentChecksum: `cs-${rid}` },
      });
    }
  });

  afterEach(async () => {
    bus.destroy();
    await tp.teardown();
  });

  /** A resolved reference — the one shape the server decorated. */
  const linkingAnnotation = (id: string): Annotation => ({
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'linking',
    target: { source: String(SOURCE), selector: [{ type: 'TextPositionSelector', start: 0, end: 4 }] },
    body: [{ type: 'SpecificResource', source: String(TARGET), purpose: 'linking' }],
    creator: { '@type': 'Person', name: 'Test User', '@id': 'did:web:test:users:test' },
    created: '2026-09-12T00:00:00.000Z',
  } as Annotation);

  it('the annotation-list read adds nothing to a resolved reference', async () => {
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: SOURCE, userId: USER, version: 1,
      payload: { annotation: linkingAnnotation('ann-linked') },
    });

    const annotations = await AnnotationContext.getAllAnnotations(SOURCE, { views: eventStore.viewStorage });
    const linked = annotations.find((a) => a.id === 'ann-linked');
    expect(linked, 'the linking annotation must be in the read').toBeDefined();

    // Named rather than counted: a failure should say WHICH key leaked.
    expect(undeclaredKeys(linked!)).toEqual([]);
  });

  it('holds for every annotation the read returns, not just the linked one', async () => {
    // A highlight has no body to resolve, so it was never decorated — it is
    // here so the gate covers the whole reply rather than one motivation.
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: SOURCE, userId: USER, version: 1,
      payload: { annotation: linkingAnnotation('ann-a') },
    });
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: SOURCE, userId: USER, version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: annotationId('ann-highlight'),
          motivation: 'highlighting',
          target: { source: String(SOURCE), selector: [{ type: 'TextPositionSelector', start: 5, end: 9 }] },
          creator: { '@type': 'Person', name: 'Test User', '@id': 'did:web:test:users:test' },
          created: '2026-09-12T00:00:00.000Z',
        } as Annotation,
      },
    });

    const annotations = await AnnotationContext.getAllAnnotations(SOURCE, { views: eventStore.viewStorage });
    expect(annotations.length).toBeGreaterThanOrEqual(2);
    for (const a of annotations) {
      expect(undeclaredKeys(a), `annotation ${a.id} carries undeclared keys`).toEqual([]);
    }
  });

  it('the derived allow-set is the spec itself, not a copy of it', async () => {
    // If this file ever stopped reading the schema, the gate above would pass
    // against whatever list someone typed here. Pin the derivation.
    expect(SPEC_KEYS.has('motivation')).toBe(true);
    expect(SPEC_KEYS.has('_resolvedDocumentName')).toBe(false);
    expect(SPEC_KEYS.size).toBeGreaterThan(5);
  });
});
