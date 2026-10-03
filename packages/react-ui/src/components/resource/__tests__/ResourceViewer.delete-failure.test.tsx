/**
 * A delete the knowledge base refuses is reported, not dropped.
 *
 * `client.mark.delete` rejects when the command fails. Uncaught, that is an
 * unhandled rejection: the annotation stays, and nothing tells the person why.
 * The viewer is the caller that knows whose command failed on which resource,
 * so it reports `mark:delete-error` — the client-local, resource-stamped notice
 * a host's outcome toasts read — through `client.mark.reportDeleteError`.
 *
 * This runs on a real session with no mark state unit mounted: an embedded
 * `ResourceViewer` has none, which is why the report cannot be left to one.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { Annotation, ResourceDescriptor as SemiontResource } from '@semiont/core';
import { annotationId, resourceId } from '@semiont/core';
import { createTestSemiontWrapper } from '../../../test-utils';
import { ResourceViewer } from '../ResourceViewer';

const resource: SemiontResource & { content: string } = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  '@id': resourceId('res-1'),
  name: 'Doc',
  created: '2024-01-01T00:00:00Z',
  entityTypes: [],
  archived: false,
  representations: [{ mediaType: 'text/plain', byteSize: 10 }],
  content: 'Some content to annotate.',
};

const highlight: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('ann-1'),
  motivation: 'highlighting',
  created: '2026-01-01T00:00:00.000Z',
  target: { source: resourceId('res-1'), selector: { type: 'TextPositionSelector', start: 0, end: 4 } },
};

const annotations = { highlights: [highlight], references: [], assessments: [], comments: [], tags: [] };

describe('ResourceViewer — a refused delete', () => {
  it('reports mark:delete-error, stamped with the resource, instead of dropping the rejection', async () => {
    const { session, eventBus, client } = createTestSemiontWrapper();
    vi.spyOn(client.mark, 'delete').mockRejectedValue(new Error('the knowledge base refused the delete'));
    const reported: unknown[] = [];
    const sub = eventBus.on('mark:delete-error').subscribe((e) => reported.push(e));

    render(
      <ResourceViewer
        session={session}
        resource={resource}
        annotations={annotations}
        annotateMode
        clickAction="deleting"
        onOpenResource={vi.fn()}
        onOpenPanel={vi.fn()}
      />,
    );

    // Clicking the annotation in delete mode asks for confirmation.
    act(() => {
      eventBus.emit('browse:click', { annotationId: annotationId('ann-1') });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(client.mark.delete).toHaveBeenCalledWith(resourceId('res-1'), annotationId('ann-1'));
    await waitFor(() => {
      expect(reported).toEqual([{ resourceId: 'res-1', message: 'the knowledge base refused the delete' }]);
    });
    sub.unsubscribe();
  });
});
