/**
 * The embeddable resource viewer — keystone acceptance spec.
 *
 * The consumer's (my-chat) actual requirement: render + interact with a resource
 * fed ONLY a `SemiontSession` and a language, with NO provider of any kind
 * mounted. react-ui assumes no language, so the language is a required prop: a
 * locale, or the host's own translation manager. The viewer mounts its own
 * translation provider from it. These tests render the viewer as an embedder
 * does: with exactly its props, and no wrapper.
 *
 * `ResourceViewer` threads its `session` down: the browse-mode subtree
 * (ResourceViewer → BrowseView → AnnotateToolbar) renders provider-free from a
 * bare session. The annotate-mode subtree is covered by
 * AnnotateView.embeddable.test.tsx.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';
import { annotationId, resourceId, EventBus } from '@semiont/core';
import { createTestSemiontWrapper, englishTranslationManager } from '../../../test-utils';
import { ResourceViewer } from '../ResourceViewer';

// Minimal bring-your-own-session double: just the surface ResourceViewer + its
// subtree touch — `client.browse` / `client.mark` and the bus its event hooks read.
function fakeSession(): SemiontSession {
  const client = {
    bus: new EventBus(),
    baseUrl: 'http://localhost:4000',
    browse: { invalidateAnnotationList: vi.fn(), click: vi.fn() },
    mark: { delete: vi.fn() },
  };
  return {
    client,
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

/**
 * A highlight the viewer has actually loaded. Required because a click carries
 * only the annotation id: the click handler resolves the annotation by id and
 * derives the motivation from it, so a click for an id absent from this
 * collection is a no-op.
 */
const loadedHighlight: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('ann-1'),
  motivation: 'highlighting',
  created: '2026-01-01T00:00:00.000Z',
  target: { source: resourceId('res-1'), selector: { type: 'TextPositionSelector', start: 0, end: 10 } },
};

const annotationsWithHighlight = { ...annotations, highlights: [loadedHighlight] };

describe('ResourceViewer — embeddable (bring-your-own-session, no session provider)', () => {
  // The whole browse-mode subtree (ResourceViewer → BrowseView →
  // AnnotateToolbar) renders provider-free from a bare session.
  it('renders content fed only a session, with no session provider mounted', () => {
    render(
      <ResourceViewer
        translationManager={englishTranslationManager}
        session={fakeSession()}
        resource={resource}
        annotations={annotations}
        onOpenResource={vi.fn()}
        onOpenPanel={vi.fn()}
      />,
    );
    expect(screen.getByText('Embeddable content.')).toBeInTheDocument();
  });

  it("renders with a locale of react-ui's own, loading its strings, with nothing above it", async () => {
    render(
      <ResourceViewer
        locale="en"
        session={fakeSession()}
        resource={resource}
        annotations={annotations}
        onOpenResource={vi.fn()}
        onOpenPanel={vi.fn()}
      />,
    );
    expect(await screen.findByText('Embeddable content.')).toBeInTheDocument();
  });

  it('does not compile without a language, or with two', () => {
    const elements = [
      // @ts-expect-error no language: react-ui assumes none
      <ResourceViewer session={fakeSession()} resource={resource} annotations={annotations} />,
      // @ts-expect-error a locale and a manager both: the language is one or the other
      <ResourceViewer locale="en" translationManager={englishTranslationManager} session={fakeSession()} resource={resource} annotations={annotations} />,
    ];
    expect(elements).toHaveLength(2);
  });

  // The viewer is a pass-through for view geometry — an
  // anchorRect arriving on browse:click reaches the host's onOpenPanel
  // untouched (detail routing, the default click action).
  it('forwards the browse:click anchorRect into onOpenPanel', async () => {
    const { session, eventBus } = createTestSemiontWrapper();
    const onOpenPanel = vi.fn();

    render(
      <ResourceViewer
        translationManager={englishTranslationManager}
        session={session}
        resource={resource}
        annotations={annotationsWithHighlight}
        onOpenResource={vi.fn()}
        onOpenPanel={onOpenPanel}
      />,
    );

    const anchorRect = {
      x: 5, y: 6, width: 7, height: 8,
      top: 6, right: 12, bottom: 14, left: 5,
    };
    act(() => {
      eventBus.emit('browse:click', {
        annotationId: annotationId('ann-1'),
        anchorRect,
      });
    });

    await waitFor(() => {
      expect(onOpenPanel).toHaveBeenCalledWith(expect.objectContaining({
        panel: 'annotations',
        scrollToAnnotationId: 'ann-1',
        // Derived from the annotation the id names, never carried on the wire.
        motivation: 'highlighting',
        anchorRect: expect.objectContaining({ left: 5, width: 7 }),
      }));
    });
  });

  // The viewer reads the host's callbacks through refs. A host that passes a
  // new function on each render must be called with the one it passed last.
  it('calls the onOpenPanel of the latest render', async () => {
    const { session, eventBus } = createTestSemiontWrapper();
    const first = vi.fn();
    const latest = vi.fn();

    const { rerender } = render(
      <ResourceViewer
        translationManager={englishTranslationManager}
        session={session}
        resource={resource}
        annotations={annotationsWithHighlight}
        onOpenResource={vi.fn()}
        onOpenPanel={first}
      />,
    );
    rerender(
      <ResourceViewer
        translationManager={englishTranslationManager}
        session={session}
        resource={resource}
        annotations={annotationsWithHighlight}
        onOpenResource={vi.fn()}
        onOpenPanel={latest}
      />,
    );

    act(() => {
      eventBus.emit('browse:click', { annotationId: annotationId('ann-1') });
    });

    await waitFor(() => expect(latest).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
  });

  it('ignores a browse:click naming an annotation this viewer has not loaded', async () => {
    // A remote drive can arrive while the participant is looking at something
    // else. Resolving the annotation FIRST makes that a no-op by construction,
    // which is why the channel carries no resourceId guard.
    const { session, eventBus } = createTestSemiontWrapper();
    const onOpenPanel = vi.fn();

    render(
      <ResourceViewer
        translationManager={englishTranslationManager}
        session={session}
        resource={resource}
        annotations={annotationsWithHighlight}
        onOpenResource={vi.fn()}
        onOpenPanel={onOpenPanel}
      />,
    );

    act(() => {
      eventBus.emit('browse:click', { annotationId: annotationId('ann-not-here') });
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onOpenPanel).not.toHaveBeenCalled();
  });
});
