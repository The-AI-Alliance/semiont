/**
 * The embeddable viewer — AnnotateView + AnnotateToolbar provider-free.
 *
 * AnnotateView takes `session` + `sparkleAnnotationIds` as props; the REAL
 * AnnotateToolbar (not mocked — its provider-freedom is the crux here) reads
 * no session provider. CodeMirrorRenderer is mocked (heavy; already prop-based).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderInEnglish } from '../../../test-utils';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { AnnotationUIState } from '../../../types/annotation-props';
import { AnnotateView } from '../AnnotateView';
import { resourceId } from '@semiont/core';

vi.mock('../../CodeMirrorRenderer', () => ({ CodeMirrorRenderer: () => <div>cm-mock</div> }));

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };
const uiState: AnnotationUIState = {
  selectedMotivation: 'linking',
  selectedClick: 'detail',
  selectedShape: 'rectangle',
  hoveredAnnotationId: null,
  scrollToAnnotationId: null,
};

function fakeSession(): SemiontSession {
  return {
    client: {
      mark: { request: vi.fn() },
    },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

describe('AnnotateView — embeddable (session prop, no session provider)', () => {
  it('renders (incl. the real AnnotateToolbar) fed only a session, no session provider', () => {
    renderInEnglish(
      <AnnotateView resourceUri={resourceId("res-1")}
        content="hello"
        mimeType="text/plain"
        annotations={emptyAnnotations}
        uiState={uiState}
        annotateMode={true}
        session={fakeSession()}
      />,
    );
    // The tree (real AnnotateToolbar + mocked CodeMirror) rendered without a session provider.
    expect(screen.getByText('cm-mock')).toBeInTheDocument();
  });
});
