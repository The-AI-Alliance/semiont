/**
 * EMBEDDABLE-VIEWER-COMPLETION Phase 1 — inline embedding.
 *
 * `inline` is a display variant (default: today's pane behavior, frontend
 * untouched): the viewer renders at content height in a bare container — no
 * inner scroll container, no pane chrome. jsdom can't compute stylesheet
 * layout, so this spec pins the two testable seams: (1) the components emit
 * the `--inline` modifier classes; (2) the stylesheet contains the inline
 * overrides (height:auto / overflow:visible / padding drop). The visual
 * auto-height check is the plan's live smoke-test.
 *
 * Started RED (no `inline` prop) and GREEN once Phase 1 lands.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SemiontSession } from '@semiont/sdk';
import type { ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';
import { BrowseView } from '../BrowseView';
import { ResourceViewer } from '../ResourceViewer';

vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function fakeSession(): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

const resource: SemiontResource & { content: string } = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  '@id': 'res-1' as ResourceId,
  name: 'Doc',
  created: '2024-01-01T00:00:00Z',
  entityTypes: [],
  archived: false,
  representations: [{ mediaType: 'text/plain', byteSize: 10 }],
  content: 'Inline content.',
};

describe('inline embedding (Phase 1)', () => {
  it('BrowseView: `inline` adds the modifier class; default does not', () => {
    const props = {
      content: 'x', mimeType: 'text/plain', resourceUri: 'res-1',
      annotations: emptyAnnotations, annotateMode: false, session: fakeSession(),
    };
    const { container: pane } = render(<BrowseView {...props} />);
    expect(pane.querySelector('.semiont-browse-view')).not.toHaveClass('semiont-browse-view--inline');

    const { container } = render(<BrowseView {...props} inline />);
    expect(container.querySelector('.semiont-browse-view')).toHaveClass('semiont-browse-view--inline');
  });

  it('ResourceViewer: `inline` marks its root and threads to BrowseView', () => {
    const { container } = render(
      <ResourceViewer
        resource={resource} annotations={emptyAnnotations}
        session={fakeSession()} inline
      />,
    );
    expect(container.querySelector('.semiont-resource-viewer')).toHaveClass('semiont-resource-viewer--inline');
    expect(container.querySelector('.semiont-browse-view')).toHaveClass('semiont-browse-view--inline');
  });

  it('stylesheet carries the inline overrides (static gate — layout itself is the live check)', () => {
    // vitest runs with cwd = the package root (same in CI's per-workspace run).
    const css = readFileSync(resolve(process.cwd(), 'src/styles/features/resource-viewer.css'), 'utf8');
    // Auto-height roots, and the content area stops being a scroll container / drops the pane gutter.
    expect(css).toMatch(/\.semiont-resource-viewer--inline\s*\{[^}]*height:\s*auto/);
    expect(css).toMatch(/\.semiont-browse-view--inline\s*\{[^}]*height:\s*auto/);
    expect(css).toMatch(/\.semiont-browse-view--inline\s+\.semiont-browse-view__content\s*\{[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.semiont-browse-view--inline\s+\.semiont-browse-view__content\s*\{[^}]*padding:\s*0/);
  });
});
