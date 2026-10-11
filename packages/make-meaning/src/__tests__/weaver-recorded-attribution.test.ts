/**
 * The graph says what the record says about who and when.
 *
 * The knowledge base derives an annotation's creator and a resource's
 * attribution when it records them: the party that asked, and the software
 * that did the work when the two differ. An event's own `userId` is the
 * party that SENT it, which for delegated work is the worker's agent. A fold
 * that derives attribution again from `userId` names the model as the creator
 * of what a person asked for, and a fold that stamps its own clock dates
 * every resource to the last time the Weaver ran.
 */
import { describe, it, expect } from 'vitest';
import { annotationId, resourceId } from '@semiont/core';
import type { Annotation } from '@semiont/core';
import {
  awaitMarks,
  buildWeaverRig,
  makeAnnotationPayload,
  maxSeqs,
  serveHistory,
  storedEvent,
} from './helpers/weaver-harness';

const ASKER = { '@type': 'Person' as const, '@id': 'did:web:test:users:asker', name: 'asker' };
const WORKER_AGENT = { '@type': 'Software' as const, '@id': 'did:web:test:agents:anthropic:model', name: 'model' };
const WORKER = WORKER_AGENT['@id'];
const RECORDED_AT = '2020-03-04T05:06:07.000Z';

const created = (rid: string, seq: number, payload: { wasAttributedTo?: typeof ASKER | Array<typeof ASKER | typeof WORKER_AGENT> } = {}) =>
  storedEvent(
    'yield:created',
    rid,
    { name: rid, format: 'text/plain', contentChecksum: `cs-${rid}`, ...payload },
    seq,
    { sentBy: WORKER, at: RECORDED_AT },
  );

describe('an annotation\'s creator', () => {
  it('is the one the event records, not the party that sent the event', async () => {
    const rig = await buildWeaverRig();
    const asked: Annotation = { ...makeAnnotationPayload('ann-asked', 'res-asked'), creator: ASKER };
    const history = [
      created('res-asked', 1, { wasAttributedTo: [ASKER, WORKER_AGENT] }),
      storedEvent('mark:added', 'res-asked', { annotation: asked }, 2, { sentBy: WORKER }),
    ];
    try {
      for (const e of history) rig.push(e);
      expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);

      expect((await rig.graph.getAnnotation(annotationId('ann-asked')))?.creator).toEqual(ASKER);
    } finally {
      await rig.dispose();
    }
  });

  it('is never made up: an annotation recorded with none is not applied', async () => {
    const rig = await buildWeaverRig();
    const { creator: _none, ...unattributed } = makeAnnotationPayload('ann-none', 'res-none');
    const history = [
      created('res-none', 1, { wasAttributedTo: ASKER }),
      storedEvent('mark:added', 'res-none', { annotation: unattributed }, 2, { sentBy: WORKER }),
    ];
    try {
      for (const e of history) rig.push(e);
      expect(await awaitMarks(rig.weaver, new Map([['res-none', 1]]))).toBe(true);
      expect(await awaitMarks(rig.weaver, new Map([['res-none', 2]]), 200)).toBe(false);

      expect(await rig.graph.getAnnotation(annotationId('ann-none'))).toBeNull();
      expect(rig.weaver.getHealthMetrics().applyFailures).toBeGreaterThanOrEqual(1);
    } finally {
      await rig.dispose();
    }
  });

  it('is compared by reconcile like any other field, and healed from the log', async () => {
    const rig = await buildWeaverRig();
    const rid = 'res-creator';
    const history = [
      created(rid, 1, { wasAttributedTo: ASKER }),
      storedEvent('mark:added', rid, { annotation: makeAnnotationPayload('ann-creator', rid) }, 2),
    ];
    const recorded = makeAnnotationPayload('ann-creator', rid).creator;
    const stopServing = serveHistory(rig.eventBus, history);
    try {
      for (const e of history) rig.push(e);
      expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);

      await rig.graph.updateAnnotation(annotationId('ann-creator'), { creator: WORKER_AGENT });

      const summary = await rig.weaver.reconcile();
      expect(summary).toMatchObject({ divergent: 1, healed: 1 });
      expect((await rig.graph.getAnnotation(annotationId('ann-creator')))?.creator).toEqual(recorded);
    } finally {
      stopServing();
      await rig.dispose();
    }
  });
});

describe('a resource\'s attribution and date', () => {
  it('are the ones its event records: both parties, and the moment it was recorded', async () => {
    const rig = await buildWeaverRig();
    const history = [created('res-both', 1, { wasAttributedTo: [ASKER, WORKER_AGENT] })];
    const stopServing = serveHistory(rig.eventBus, history);
    try {
      for (const e of history) rig.push(e);
      expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);

      const inGraph = await rig.graph.getResource(resourceId('res-both'));
      expect(inGraph?.wasAttributedTo).toEqual([ASKER, WORKER_AGENT]);
      expect(inGraph?.dateCreated).toBe(RECORDED_AT);

      // A rebuild applies the same event at another time, and the graph says the same.
      await rig.weaver.rebuildResource(resourceId('res-both'));
      const rebuilt = await rig.graph.getResource(resourceId('res-both'));
      expect(rebuilt?.dateCreated).toBe(RECORDED_AT);
      expect(rebuilt?.wasAttributedTo).toEqual([ASKER, WORKER_AGENT]);
    } finally {
      stopServing();
      await rig.dispose();
    }
  });
});

describe('a graph the fold has just built', () => {
  // Reconcile compares the graph with what the codec says it should hold for
  // each annotation of the VIEW. So whatever the view holds that the codec
  // stores, the fold has to have stored: an annotation's generator, which the
  // record carries on everything a worker made; and `modified`, which the
  // Archivist's view stamps with the moment of each body update. A fold that
  // leaves either out builds a graph reconcile calls divergent, heals it from
  // the same events into the same graph, and calls it divergent again at the
  // next boot.
  const UPDATED_AT = '2021-06-07T08:09:10.000Z';

  it('is one reconcile finds nothing wrong with: a worker\'s annotation keeps its generator', async () => {
    const rig = await buildWeaverRig();
    const rid = 'res-generated';
    const made: Annotation = { ...makeAnnotationPayload('ann-generated', rid), creator: ASKER, generator: WORKER_AGENT };
    const history = [
      created(rid, 1, { wasAttributedTo: [ASKER, WORKER_AGENT] }),
      storedEvent('mark:added', rid, { annotation: made }, 2, { sentBy: WORKER }),
    ];
    const stopServing = serveHistory(rig.eventBus, history, { [rid]: [made] });
    try {
      for (const e of history) rig.push(e);
      expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);

      expect((await rig.graph.getAnnotation(annotationId('ann-generated')))?.generator).toEqual(WORKER_AGENT);
      expect(await rig.weaver.reconcile()).toMatchObject({ divergent: 0, healed: 0 });
    } finally {
      stopServing();
      await rig.dispose();
    }
  });

  it('is one reconcile finds nothing wrong with: an updated body is dated as the view dates it', async () => {
    const rig = await buildWeaverRig();
    const rid = 'res-updated';
    const { body: _none, ...added } = makeAnnotationPayload('ann-updated', rid);
    const tag = { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const };
    const history = [
      created(rid, 1, { wasAttributedTo: ASKER }),
      storedEvent('mark:added', rid, { annotation: added }, 2),
      storedEvent('mark:body-updated', rid, { annotationId: annotationId('ann-updated'), operations: [{ op: 'add', item: tag }] }, 3, { at: UPDATED_AT }),
    ];
    // As the Archivist's view holds it after the update: the body the
    // operations leave, and `modified` at the update's moment.
    const inView: Annotation = { ...added, body: [tag], modified: UPDATED_AT };
    const stopServing = serveHistory(rig.eventBus, history, { [rid]: [inView] });
    try {
      for (const e of history) rig.push(e);
      expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);

      expect(await rig.graph.getAnnotation(annotationId('ann-updated'))).toMatchObject({ body: [tag], modified: UPDATED_AT });
      expect(await rig.weaver.reconcile()).toMatchObject({ divergent: 0, healed: 0 });
    } finally {
      stopServing();
      await rig.dispose();
    }
  });
});
