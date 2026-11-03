// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createTestSession, inMemoryContent, refuseUnscriptedOperation } from '@semiont/sdk/testing';
import { renderInApp } from '../lib/test-render';
import type { ViewerPrefs } from './ViewerPrefControls';
import { ResourceView } from './ResourceView';

const NAME = 'Black Hawk War';
const TEXT = 'The war ended with the defeat of Black Hawk’s band.';
const PREFS: ViewerPrefs = {
  clickAction: 'follow',
  onClickActionChange: () => {},
  motivation: null,
  onMotivationChange: () => {},
};

/** A knowledge base holding one text document: its bytes and its (no) annotations in the
 *  in-memory content transport (which refuses an id it was not given), its descriptor
 *  answered over the scripted transport, anything else refused by name. */
async function sessionWithOneDocument() {
  const content = inMemoryContent();
  const { resourceId } = await content.putBinary({
    name: NAME,
    file: new File([TEXT], 'black-hawk-war.txt', { type: 'text/plain' }),
    format: 'text/plain',
    storageUri: 'file://black-hawk-war.txt',
  });
  const stack = createTestSession({
    content: { ...content, getAnnotations: async () => ({ annotations: [], total: 0 }) },
    transport: {
      makeResponse: (op) => {
        if (op === 'browse:resource-requested') {
          return {
            resource: {
              '@context': 'https://schema.org/',
              '@id': resourceId,
              name: NAME,
              representations: [{ mediaType: 'text/plain', checksum: 'sha256:0', byteSize: TEXT.length }],
            },
            annotations: [],
            entityReferences: [],
          };
        }
        return refuseUnscriptedOperation(op);
      },
    },
  });
  return { ...stack, resourceId };
}

describe('a document opened in the document pane, as the app mounts it', () => {
  it('shows its text through react-ui’s viewer, and in annotate mode, without a render error', async () => {
    const { session, resourceId } = await sessionWithOneDocument();
    const view = await renderInApp(
      <ResourceView
        session={session}
        prefs={PREFS}
        resourceId={resourceId}
        name={NAME}
        onClose={() => {}}
        onOpenResource={() => {}}
      />,
    );
    try {
      await view.until(
        () => (view.container.querySelector('.semiont-browse-view')?.textContent ?? '').includes(TEXT),
        'the document’s text in the viewer',
      );
      expect(view.errors).toEqual([]);

      await view.click('[aria-label="Annotate this document"]');
      await view.until(() => view.container.querySelector('.semiont-annotate-view') !== null, 'annotate mode');
      expect(view.errors).toEqual([]);
    } finally {
      view.unmount();
      await session.dispose();
    }
  });
});
