/**
 * EMBEDDABLE-RESOURCE-VIEWER step 3 — overridable browse media-renderer registry.
 *
 * A consumer can swap a media renderer via the `renderers` prop (e.g. its own PDF
 * viewer) without forking BrowseView. AnnotateToolbar is mocked (unrelated here).
 *
 * Started RED (tsc: no `renderers` prop) and GREEN once step 3 lands.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import { BrowseView } from '../BrowseView';
import type { MediaRendererProps } from '../browse-renderers';

vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function fakeSession(): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

describe('BrowseView — media-renderer registry', () => {
  it('uses a custom renderer from the `renderers` override', () => {
    const CustomText = ({ content }: MediaRendererProps) => <div>custom-render: {content}</div>;
    render(
      <BrowseView
        content="the-body"
        mimeType="text/plain"
        resourceUri="res-1"
        annotations={emptyAnnotations}
        annotateMode={false}
        session={fakeSession()}
        renderers={{ text: CustomText }}
      />,
    );
    expect(screen.getByText(/custom-render: the-body/)).toBeInTheDocument();
  });
});
