/**
 * EMBEDDABLE-RESOURCE-VIEWER — keystone acceptance spec.
 *
 * The consumer's (my-chat) actual requirement: render + interact with a resource
 * fed ONLY a `SemiontSession`, with NO SemiontProvider / TranslationProvider /
 * cache context mounted. This is the definition of done for provider-free
 * rendering — the "an external host can import the pieces" half of the plan's
 * dual acceptance test.
 *
 * GREEN as of step 1c: the browse-mode subtree (ResourceViewer → BrowseView →
 * AnnotateToolbar) renders provider-free from a bare session. The annotate-mode
 * subtree is covered by AnnotateView.embeddable.test.tsx.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';
import { ResourceViewer } from '../ResourceViewer';

// Minimal bring-your-own-session double: just the surface ResourceViewer + its
// subtree touch — `client.browse` / `client.mark` and generic-channel `subscribe`.
function fakeSession(): SemiontSession {
  const client = {
    baseUrl: 'http://localhost:4000',
    browse: { invalidateAnnotationList: vi.fn(), click: vi.fn() },
    mark: { delete: vi.fn() },
  };
  return {
    client,
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
  content: 'Embeddable content.',
};

const annotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

describe('ResourceViewer — embeddable (bring-your-own-session, no providers)', () => {
  // GREEN: the whole browse-mode subtree (ResourceViewer → BrowseView →
  // AnnotateToolbar) renders provider-free from a bare session.
  it('renders content fed only a session, with NO providers mounted', () => {
    render(
      <ResourceViewer
        session={fakeSession()}
        resource={resource}
        annotations={annotations}
        onOpenResource={vi.fn()}
        onOpenPanel={vi.fn()}
      />,
    );
    expect(screen.getByText('Embeddable content.')).toBeInTheDocument();
  });
});
