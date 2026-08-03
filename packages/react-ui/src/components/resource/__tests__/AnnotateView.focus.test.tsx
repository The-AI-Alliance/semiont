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
