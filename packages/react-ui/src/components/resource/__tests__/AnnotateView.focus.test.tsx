/**
 * In-content scroll on `beckon:focus`.
 *
 * `beckon:focus` is the "scroll to and highlight this annotation" contract,
 * and BrowseView and AnnotateView both subscribe to it. The history panel
 * produces the event, so a view that ignored it would make the same click
 * work or not depending on the mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import type { AnnotationUIState } from '../../../types/annotation-props';
import { createTestSemiontWrapper, renderInEnglish } from '../../../test-utils';

const scrollSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/scroll-utils', () => ({
  scrollAnnotationIntoView: scrollSpy,
}));
vi.mock('../../CodeMirrorRenderer', () => ({
  CodeMirrorRenderer: () => <div data-annotation-id="ann-7">cm-mock</div>,
}));

import { AnnotateView } from '../AnnotateView';
import { annotationId, resourceId } from '@semiont/core';

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };
const uiState: AnnotationUIState = {
  selectedMotivation: 'linking',
  selectedClick: 'detail',
  selectedShape: 'rectangle',
  hoveredAnnotationId: null,
  scrollToAnnotationId: null,
};

describe('AnnotateView — beckon:focus scrolls the content', () => {
  beforeEach(() => { scrollSpy.mockClear(); });

  it('scrolls to the annotation when the session emits beckon:focus', () => {
    const { session, client } = createTestSemiontWrapper();

    renderInEnglish(
      <AnnotateView
        content="hello world"
        mimeType="text/plain"
        resourceUri={resourceId("res-1")}
        annotations={emptyAnnotations}
        uiState={uiState}
        session={session}
        annotateMode
      />,
    );

    client.bus.emit('beckon:focus', { annotationId: annotationId('ann-7') });

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.calls[0]?.[0]).toBe('ann-7');
  });
});

// ─────────────────────────────────────────────────────────────────────
// `resourceId` on `beckon:focus` is a GUARD, not navigation.
//
// The schema says so out loud: "it names the resource this focus applies
// to, and a viewer currently showing a different resource ignores the event".
// Without the comparison the field is decorative — a guide beckoning a
// reference in doc B scrolls every participant's doc A.
// ─────────────────────────────────────────────────────────────────────
describe('AnnotateView — beckon:focus is guarded by resourceId', () => {
  beforeEach(() => { scrollSpy.mockClear(); });

  const renderAt = (resourceUri: string) => {
    const { session, client } = createTestSemiontWrapper();
    renderInEnglish(
      <AnnotateView
        content="hello world"
        mimeType="text/plain"
        resourceUri={resourceId(resourceUri)}
        annotations={emptyAnnotations}
        uiState={uiState}
        session={session}
        annotateMode
      />,
    );
    return client;
  };

  it('ignores a focus aimed at a DIFFERENT resource', () => {
    const client = renderAt('res-1');
    client.bus.emit('beckon:focus', { annotationId: annotationId('ann-7'), resourceId: resourceId('res-2') });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('still scrolls when the resource matches', () => {
    const client = renderAt('res-1');
    client.bus.emit('beckon:focus', { annotationId: annotationId('ann-7'), resourceId: resourceId('res-1') });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('still scrolls when the event names no resource at all', () => {
    // `resourceId` is optional in the schema (`required: []`), and the in-app
    // emitters — the history panel, the annotation list — omit it because they
    // are already scoped to the open resource. A guard that treated absence as
    // "not mine" would break every one of them.
    const client = renderAt('res-1');
    client.bus.emit('beckon:focus', { annotationId: annotationId('ann-7') });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });
});
