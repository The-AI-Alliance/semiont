/**
 * ASSIST-SURFACE-WARTS Lane D — in-content scroll on `beckon:focus`.
 *
 * `beckon:focus` is the established "scroll to and highlight this annotation"
 * contract; BrowseView has subscribed to it all along. AnnotateView did not,
 * so the same event scrolled the content in browse mode and did nothing in
 * annotate mode. With the history panel now producing the event, that asymmetry
 * becomes user-visible: the same click works or doesn't depending on the mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { AnnotationUIState } from '../../../types/annotation-props';
import { createTestSemiontWrapper } from '../../../test-utils';

const scrollSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/scroll-utils', () => ({
  scrollAnnotationIntoView: scrollSpy,
}));
vi.mock('../../CodeMirrorRenderer', () => ({
  CodeMirrorRenderer: () => <div data-annotation-id="ann-7">cm-mock</div>,
}));

import { AnnotateView } from '../AnnotateView';

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

    render(
      <AnnotateView
        content="hello world"
        mimeType="text/plain"
        resourceUri="res-1"
        annotations={emptyAnnotations}
        uiState={uiState}
        session={session}
        annotateMode
      />,
    );

    client.bus.get('beckon:focus').next({ annotationId: 'ann-7' });

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.calls[0]?.[0]).toBe('ann-7');
  });
});

// ─────────────────────────────────────────────────────────────────────
// GUIDED-TOUR P6 (D7) — `resourceId` is a GUARD, not navigation.
//
// The schema now says so out loud: "it names the resource this focus applies
// to, and a viewer currently showing a different resource ignores the event".
// Without the comparison the field was decorative — a guide beckoning a
// reference in doc B scrolled every participant's doc A.
// ─────────────────────────────────────────────────────────────────────
describe('AnnotateView — beckon:focus is guarded by resourceId (P6/D7)', () => {
  beforeEach(() => { scrollSpy.mockClear(); });

  const renderAt = (resourceUri: string) => {
    const { session, client } = createTestSemiontWrapper();
    render(
      <AnnotateView
        content="hello world"
        mimeType="text/plain"
        resourceUri={resourceUri}
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
    client.bus.get('beckon:focus').next({ annotationId: 'ann-7', resourceId: 'res-2' });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('still scrolls when the resource matches', () => {
    const client = renderAt('res-1');
    client.bus.get('beckon:focus').next({ annotationId: 'ann-7', resourceId: 'res-1' });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('still scrolls when the event names no resource at all', () => {
    // `resourceId` is optional in the schema (`required: []`), and the in-app
    // emitters — the history panel, the annotation list — omit it because they
    // are already scoped to the open resource. A guard that treated absence as
    // "not mine" would break every one of them.
    const client = renderAt('res-1');
    client.bus.get('beckon:focus').next({ annotationId: 'ann-7' });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });
});
