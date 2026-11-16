/**
 * VIEWER-TOOLBAR-OPT-OUT — `showToolbar={false}` is a supported opt-out.
 *
 * Tier-2 hosts (controlled props, host-composed controls) hide the built-in
 * bar by CONTRACT, not by CSS-ing react-ui's internals. Hiding the bar must
 * not disable any seam: the keystone here proves annotate-mode selection
 * capture still emits mark.request with the bar gone.
 *
 * Started RED (the prop doesn't exist; bars render everywhere) → GREEN.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';
import { ResourceViewer } from '../ResourceViewer';

// Render the real content so jsdom text selection can target it.
vi.mock('../../CodeMirrorRenderer', () => ({
  CodeMirrorRenderer: ({ content }: { content: string }) => <div className="codemirror-renderer">{content}</div>,
}));
vi.mock('../../image-annotation/SvgDrawingCanvas', () => ({ SvgDrawingCanvas: () => <div>svg-mock</div> }));
vi.mock('../../pdf-annotation/PdfAnnotationCanvas.client', () => ({ PdfAnnotationCanvas: () => <div>pdf-mock</div> }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

const CONTENT = 'hello world selectme end';

function makeResource(mediaType = 'text/plain'): SemiontResource & { content: string } {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    '@id': 'res-1' as ResourceId,
    name: 'Doc',
    created: '2024-01-01T00:00:00Z',
    entityTypes: [],
    archived: false,
    representations: [{ mediaType, byteSize: 10 }],
    content: CONTENT,
  };
}

const annotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function fakeSession() {
  const client = {
    browse: { click: vi.fn(), invalidateAnnotationList: vi.fn() },
    beckon: { hover: vi.fn() },
    mark: { request: vi.fn(), delete: vi.fn() },
  };
  return { session: { client, subscribe: () => () => {} } as unknown as SemiontSession, client };
}

const bars = (c: HTMLElement) => c.querySelectorAll('.semiont-annotate-toolbar').length;

describe('ResourceViewer — showToolbar opt-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.getSelection()?.removeAllRanges();
  });

  it('default pins today’s behavior: the bar renders in browse and annotate modes', () => {
    const { session } = fakeSession();
    const browse = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations} />,
    );
    expect(bars(browse.container)).toBe(1);

    const annotate = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations}
        annotateMode={true} onAnnotateModeChange={vi.fn()} />,
    );
    expect(bars(annotate.container)).toBe(1);
  });

  it('showToolbar={false}: no bar in browse mode', () => {
    const { session } = fakeSession();
    const { container } = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations}
        showToolbar={false} />,
    );
    expect(bars(container)).toBe(0);
    expect(screen.getByText(CONTENT)).toBeInTheDocument(); // content still renders
  });

  it('showToolbar={false}: no bar in any annotate render mode (text / image / pdf)', async () => {
    const { session } = fakeSession();
    const text = render(
      <ResourceViewer session={session} resource={makeResource('text/plain')} annotations={annotations}
        annotateMode={true} onAnnotateModeChange={vi.fn()} showToolbar={false} />,
    );
    expect(bars(text.container)).toBe(0);

    const image = render(
      <ResourceViewer session={session} resource={makeResource('image/png')} annotations={annotations}
        annotateMode={true} onAnnotateModeChange={vi.fn()} showToolbar={false} />,
    );
    expect(within(image.container).getByText('svg-mock')).toBeInTheDocument();
    expect(bars(image.container)).toBe(0);

    const pdf = render(
      <ResourceViewer session={session} resource={makeResource('application/pdf')} annotations={annotations}
        annotateMode={true} onAnnotateModeChange={vi.fn()} showToolbar={false} />,
    );
    await within(pdf.container).findByText('pdf-mock'); // flush the lazy canvas
    expect(bars(pdf.container)).toBe(0);
  });

  it('keystone: with the bar hidden, annotate-mode selection still emits mark.request', () => {
    const { session, client } = fakeSession();
    const { container } = render(
      <ResourceViewer session={session} resource={makeResource('text/plain')} annotations={annotations}
        annotateMode={true} onAnnotateModeChange={vi.fn()}
        selectionMotivation="highlighting" onSelectionMotivationChange={vi.fn()}
        showToolbar={false} />,
    );
    expect(bars(container)).toBe(0);

    // Select "world" (offsets 6..11) inside the rendered content, then mouseup.
    const contentEl = within(container).getByText(CONTENT);
    const range = document.createRange();
    range.setStart(contentEl.firstChild!, 6);
    range.setEnd(contentEl.firstChild!, 11);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(contentEl);

    expect(client.mark.request).toHaveBeenCalledTimes(1);
    const [source, selectors, motivation] = client.mark.request.mock.calls[0]!;
    expect(String(source)).toBe('res-1');
    expect(selectors).toBeTruthy();
    expect(motivation).toBe('highlighting');
  });
});
