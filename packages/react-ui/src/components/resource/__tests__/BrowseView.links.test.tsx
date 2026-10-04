/**
 * Content-link delegation.
 *
 * A content link (`<a href>` rendered inside the resource content) must be
 * intercepted: the viewer `preventDefault`s (never navigates on its own — an
 * embedded/Electron security requirement) and delegates to `onLinkClick({href,
 * event})`. With no handler, the click is still cancelled (nothing happens).
 *
 * Started RED (no `onLinkClick` prop) and GREEN once BrowseView takes one. Real
 * react-markdown (not the mock) so the `<a>` is a genuine rendered content link.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import { BrowseView } from '../BrowseView';
import { resourceId } from '@semiont/core';

vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function fakeSession(): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

const MD = 'see [the link](https://example.test/x) here';

describe('BrowseView — content link delegation', () => {
  it('intercepts a content <a> click: preventDefault + onLinkClick(href)', () => {
    const onLinkClick = vi.fn();
    render(
      <BrowseView
        content={MD} mimeType="text/markdown" resourceUri={resourceId("res-1")}
        annotations={emptyAnnotations} annotateMode={false}
        session={fakeSession()} onLinkClick={onLinkClick}
      />,
    );
    const anchor = screen.getByText('the link').closest('a')!;
    // fireEvent.click returns false when the event was cancelled (preventDefault).
    const notCancelled = fireEvent.click(anchor);
    expect(notCancelled).toBe(false); // navigation blocked
    expect(onLinkClick).toHaveBeenCalledTimes(1);
    expect(onLinkClick.mock.calls[0]![0]).toMatchObject({ href: 'https://example.test/x' });
  });

  it('blocks navigation even with no handler (never navigates on its own)', () => {
    render(
      <BrowseView
        content={MD} mimeType="text/markdown" resourceUri={resourceId("res-1")}
        annotations={emptyAnnotations} annotateMode={false}
        session={fakeSession()}
      />,
    );
    const anchor = screen.getByText('the link').closest('a')!;
    expect(fireEvent.click(anchor)).toBe(false); // still cancelled — nothing happens, but no navigation
  });
});
