/**
 * ANNOTATE-RENDERER-REGISTRY — the annotate path's overridable media registry,
 * symmetric to EMBEDDABLE-RESOURCE-VIEWER step 3's browse registry.
 *
 * A host that brings its own PDF stack can already replace the read-only
 * renderer via `BrowseView`'s `renderers` prop; without the same seam here it
 * ends up running two PDF engines depending on which mode the user is in.
 *
 * Started RED (tsc: no `renderers` prop on AnnotateView).
 * See .plans/ANNOTATE-RENDERER-REGISTRY.md
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { AnnotationUIState } from '../../../types/annotation-props';
import { AnnotateView } from '../AnnotateView';
import type { AnnotateMediaRendererProps } from '../annotate-renderers';

vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));
vi.mock('../../CodeMirrorRenderer', () => ({
  CodeMirrorRenderer: () => <div data-testid="default-text">default-cm</div>,
}));
vi.mock('../../image-annotation/SvgDrawingCanvas', () => ({
  SvgDrawingCanvas: () => <div data-testid="default-image">default-svg</div>,
}));

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

type ViewProps = React.ComponentProps<typeof AnnotateView>;

const base = (mimeType: string): ViewProps => ({
  resourceUri: 'res-1',
  content: 'the-body',
  mimeType,
  annotations: emptyAnnotations,
  uiState,
  annotateMode: true,
  session: fakeSession(),
});

describe('AnnotateView — media-renderer registry', () => {
  it('uses a custom text renderer from the `renderers` override', () => {
    const CustomText = ({ content }: AnnotateMediaRendererProps) => (
      <div data-testid="custom-text">custom: {content}</div>
    );

    render(<AnnotateView {...base('text/plain')} renderers={{ text: CustomText }} />);

    expect(screen.getByTestId('custom-text')).toHaveTextContent('custom: the-body');
    expect(screen.queryByTestId('default-text')).not.toBeInTheDocument();
  });

  it('uses a custom pdf renderer — the realistic override, a host bringing its own viewer', () => {
    const CustomPdf = ({ content }: AnnotateMediaRendererProps) => (
      <div data-testid="custom-pdf">{content}</div>
    );

    render(<AnnotateView {...base('application/pdf')} renderers={{ pdf: CustomPdf }} />);

    expect(screen.getByTestId('custom-pdf')).toBeInTheDocument();
  });

  it('merges over the defaults rather than replacing them: overriding text leaves image alone', () => {
    const CustomText = () => <div data-testid="custom-text" />;

    render(<AnnotateView {...base('image/png')} renderers={{ text: CustomText }} />);

    expect(screen.getByTestId('default-image')).toBeInTheDocument();
    expect(screen.queryByTestId('custom-text')).not.toBeInTheDocument();
  });

  it('a mode in neither the defaults nor the override falls back to unsupported, download intact', () => {
    // Deliberately unlike the browse side, where a registry miss falls through
    // to the text renderer harmlessly. Annotating an unknown type is not
    // harmless, so the miss must stay explicit.
    const { container } = render(<AnnotateView {...base('application/octet-stream')} />);

    expect(container.querySelector('[data-mime-type="unsupported"]')).toBeInTheDocument();
    expect(screen.getByText(/Annotation not supported/)).toBeInTheDocument();
    expect(screen.getByText('Download File')).toBeInTheDocument();
  });

  it('renders one toolbar and one content shell, whatever the render mode', () => {
    // The collapse this plan is really about: three branches used to repeat
    // the wrapper, the toolbar block and the content div verbatim.
    for (const mimeType of ['text/plain', 'application/pdf', 'image/png']) {
      const { container, unmount } = render(<AnnotateView {...base(mimeType)} />);
      expect(container.querySelectorAll('.semiont-annotate-view')).toHaveLength(1);
      expect(container.querySelectorAll('.semiont-annotate-view__content')).toHaveLength(1);
      unmount();
    }
  });
});
