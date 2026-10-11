/**
 * Rebuilding one resource leaves every other resource's graph alone.
 *
 * A rebuild deletes the resource from the graph and applies that resource's
 * events again. Another resource's annotation that links to it is not among
 * those events: if the delete takes it, nothing in the rebuild puts it back,
 * and the other resource is wrong until it is rebuilt itself.
 */
import { describe, it, expect } from 'vitest';
import { annotationId, resourceId } from '@semiont/core';
import type { Annotation } from '@semiont/core';
import {
  awaitMarks,
  buildWeaverRig,
  makeAnnotationPayload,
  maxSeqs,
  RECORDED_BY,
  serveHistory,
  storedEvent,
} from './helpers/weaver-harness';

describe('rebuilding one resource', () => {
  it('keeps the annotations other resources hold that link to it', async () => {
    const rig = await buildWeaverRig();
    const link: Annotation = {
      ...makeAnnotationPayload('ann-link', 'res-from'),
      motivation: 'linking',
      body: [{ type: 'SpecificResource', source: resourceId('res-to'), purpose: 'linking' }],
    };
    const history = [
      storedEvent('yield:created', 'res-to', { name: 'To', format: 'text/plain', contentChecksum: 'cs-to', wasAttributedTo: RECORDED_BY }, 1),
      storedEvent('yield:created', 'res-from', { name: 'From', format: 'text/plain', contentChecksum: 'cs-from', wasAttributedTo: RECORDED_BY }, 1),
      storedEvent('mark:added', 'res-from', { annotation: link }, 2),
    ];
    const stopServing = serveHistory(rig.eventBus, history);
    try {
      for (const e of history) rig.push(e);
      expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);
      const linksTo = async () =>
        (await rig.graph.getResourceReferencedBy(resourceId('res-to'))).map((a) => String(a.id));
      expect(await linksTo()).toEqual(['ann-link']);

      const rebuilt = await rig.weaver.rebuildResource(resourceId('res-to'));

      expect(rebuilt).toMatchObject({ eventCount: 1, eventsFailed: 0 });
      expect(await rig.graph.getResource(resourceId('res-to'))).not.toBeNull();
      expect(await rig.graph.getAnnotation(annotationId('ann-link'))).not.toBeNull();
      expect(await linksTo()).toEqual(['ann-link']);
    } finally {
      stopServing();
      await rig.dispose();
    }
  });
});
