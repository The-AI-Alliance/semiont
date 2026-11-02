// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createTestSession, inMemoryContent, refuseUnscriptedOperation } from '@semiont/sdk/testing';
import { resourceId } from '@semiont/core';
import { renderInApp } from '../lib/test-render';
import type { ViewerPrefs } from './ViewerPrefControls';
import { MessageView } from './MessageView';

const RID = 'question-1';
const TEXT = 'What does the spec say about retries?';
const PREFS: ViewerPrefs = {
  clickAction: 'follow',
  onClickActionChange: () => {},
  motivation: null,
  onMotivationChange: () => {},
};

/** The real client over the scripted transport, answering the two loads a message's viewer
 *  makes (its resource over the bus, its annotations through the content transport) and
 *  refusing anything else, so a request this test did not expect fails it by name. */
function sessionWithOneMessage() {
  return createTestSession({
    content: { ...inMemoryContent(), getAnnotations: async () => ({ annotations: [], total: 0 }) },
    transport: {
      makeResponse: (op) => {
        if (op === 'browse:resource-requested') {
          return {
            resource: {
              '@context': 'https://schema.org/',
              '@id': resourceId(RID),
              name: TEXT,
              // A question is uploaded as markdown (chat-turn.ts), and a descriptor states its representations.
              representations: [{ mediaType: 'text/markdown', checksum: 'sha256:0', byteSize: TEXT.length }],
            },
            annotations: [],
            entityReferences: [],
          };
        }
        return refuseUnscriptedOperation(op);
      },
    },
  });
}

describe('a message, rendered as the app mounts it', () => {
  it('shows through react-ui’s viewer, and with its annotate pencil on, without a render error', async () => {
    const { session } = sessionWithOneMessage();
    const view = await renderInApp(
      <MessageView
        session={session}
        resourceId={RID}
        content={TEXT}
        prefs={PREFS}
        markableEntityTypes={[]}
        onOpenResource={() => {}}
      />,
    );
    try {
      // The plain bubble paints first; the viewer replaces it once the resource has loaded.
      await view.until(() => view.container.querySelector('.semiont-browse-view') !== null, 'the viewer');
      expect(view.errors).toEqual([]);
      expect(view.container.querySelector('.msg--plain')).toBeNull();
      expect(view.container.querySelector('.semiont-browse-view')?.textContent).toContain(TEXT);

      await view.click('[aria-label="Annotate this message"]');
      await view.until(() => view.container.querySelector('.semiont-annotate-view') !== null, 'annotate mode');
      expect(view.errors).toEqual([]);
    } finally {
      view.unmount();
      await session.dispose();
    }
  });
});
