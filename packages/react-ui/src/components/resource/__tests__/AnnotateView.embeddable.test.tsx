/**
 * EMBEDDABLE-RESOURCE-VIEWER step 1b — AnnotateView + AnnotateToolbar provider-free.
 *
 * AnnotateView takes `session` + `newAnnotationIds` as props; the REAL
 * AnnotateToolbar (not mocked — its decoupling is the crux of 1b) takes `session`
 * as a prop. CodeMirrorRenderer is mocked (heavy; already prop-based).
 *
 * Started RED (tsc: no `session` prop) and GREEN once step 1b lands.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { AnnotationUIState } from '../../../types/annotation-props';
import { AnnotateView } from '../AnnotateView';

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
      mark: {
        changeSelection: vi.fn(), changeClick: vi.fn(), changeShape: vi.fn(),
        toggleMode: vi.fn(), request: vi.fn(),
      },
    },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

describe('AnnotateView — embeddable (session prop, no providers)', () => {
  it('renders (incl. the real AnnotateToolbar) fed only a session, no providers', () => {
    render(
      <AnnotateView resourceUri="res-1"
        content="hello"
        mimeType="text/plain"
        annotations={emptyAnnotations}
        uiState={uiState}
        annotateMode={true}
        session={fakeSession()}
      />,
    );
    // The tree (real AnnotateToolbar + mocked CodeMirror) rendered without a provider.
    expect(screen.getByText('cm-mock')).toBeInTheDocument();
  });
});
