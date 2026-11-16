/**
 * The media-renderer registries must be reachable through `ResourceViewer` —
 * the documented consumer entry point.
 *
 * `BrowseView` has taken a `renderers` override since EMBEDDABLE-RESOURCE-VIEWER
 * step 3, and `AnnotateView` since 3b, but `ResourceViewer` forwarded neither.
 * A host importing it (what docs/ANNOTATIONS.md tells consumers to do, and what
 * the embeddable-surface packaging gate checks) therefore had no way to reach
 * the extension point: it would have to drop to `BrowseView` directly and
 * reimplement the browse/annotate switching `ResourceViewer` exists to provide.
 *
 * Started RED (tsc: no `browseRenderers` / `annotateRenderers` props).
 * See .plans/ANNOTATE-RENDERER-REGISTRY.md (D5)
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import { ResourceViewer } from '../ResourceViewer';
import type { MediaRendererProps } from '../browse-renderers';
import type { AnnotateMediaRendererProps } from '../annotate-renderers';

vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));
vi.mock('../../Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../../CodeMirrorRenderer', () => ({
  CodeMirrorRenderer: () => <div data-testid="default-text">default-cm</div>,
}));

function fakeSession(): SemiontSession {
  return {
    client: {
      browse: { click: vi.fn() },
      beckon: { hover: vi.fn() },
      mark: {
        changeSelection: vi.fn(), changeClick: vi.fn(), changeShape: vi.fn(),
        toggleMode: vi.fn(), request: vi.fn(),
      },
    },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

type ViewerProps = React.ComponentProps<typeof ResourceViewer>;

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

const base = (): ViewerProps => ({
  resource: {
    '@id': 'res-1',
    name: 'Doc',
    content: 'the-body',
    representations: [{ mediaType: 'text/plain' }],
  },
  annotations: emptyAnnotations,
  session: fakeSession(),
} as unknown as ViewerProps);

describe('ResourceViewer — media-renderer registries are reachable', () => {
  it('forwards browseRenderers to the read-only path', () => {
    const CustomText = ({ content }: MediaRendererProps) => (
      <div data-testid="custom-browse">{content}</div>
    );

    render(<ResourceViewer {...base()} annotateMode={false} browseRenderers={{ text: CustomText }} />);

    expect(screen.getByTestId('custom-browse')).toHaveTextContent('the-body');
  });

  it('forwards annotateRenderers to the annotating path', () => {
    const CustomText = ({ content }: AnnotateMediaRendererProps) => (
      <div data-testid="custom-annotate">{content}</div>
    );

    render(<ResourceViewer {...base()} annotateMode annotateRenderers={{ text: CustomText }} />);

    expect(screen.getByTestId('custom-annotate')).toHaveTextContent('the-body');
    expect(screen.queryByTestId('default-text')).not.toBeInTheDocument();
  });

  it('without overrides the defaults still render, in both modes', () => {
    const { unmount } = render(<ResourceViewer {...base()} annotateMode />);
    expect(screen.getByTestId('default-text')).toBeInTheDocument();
    unmount();

    render(<ResourceViewer {...base()} annotateMode={false} />);
    expect(screen.getByText(/the-body/)).toBeInTheDocument();
  });
});
