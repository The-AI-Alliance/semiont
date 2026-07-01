/**
 * EMBEDDABLE-RESOURCE-VIEWER step 1a — BrowseView renders provider-free.
 *
 * BrowseView takes its `session` + `newAnnotationIds` as props (not
 * `useSemiont()` / `useResourceAnnotations()`), and subscribes to session-scoped
 * beckon events via `session.subscribe`. `AnnotateToolbar` is mocked here — its
 * own provider decoupling is step 1b — so this spec isolates BrowseView's body.
 *
 * Started RED (tsc: no `session` prop) and GREEN once step 1a lands.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import { BrowseView } from '../BrowseView';

// AnnotateToolbar still calls useSemiont() (step 1b) — stub it out so this spec
// exercises only BrowseView's own provider-freedom.
vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function fakeSession(): SemiontSession {
  return {
    client: {
      browse: { click: vi.fn() },
      beckon: { hover: vi.fn() },
    },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

describe('BrowseView — embeddable (session prop, no providers)', () => {
  it('renders content fed only a session, with NO providers mounted', () => {
    render(
      <BrowseView
        content="Embeddable browse content."
        mimeType="text/plain"
        resourceUri="res-1"
        annotations={emptyAnnotations}
        annotateMode={false}
        session={fakeSession()}
      />,
    );
    expect(screen.getByText('Embeddable browse content.')).toBeInTheDocument();
  });
});
