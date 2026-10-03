/**
 * ResourceViewerPage — content loading has ONE owner, and loads only what the
 * viewer mounts.
 *
 * The page reads its content through `useResourceContent` (a text view) and
 * `useMediaToken` (an image/PDF view). Anything else that loads content on
 * mount is a download nobody reads — a second owner, or bytes for a type the
 * viewer has no preview for. These specs mount the real page over the SDK's
 * in-memory doubles and count what reaches the content transport and the
 * gateway — the wire, not a mocked hook.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import type { ResourceDescriptor } from '@semiont/core';
import { SemiontBrowser, SessionSignals } from '@semiont/sdk';
import { createTestSession, inMemoryContent, stubGateway } from '@semiont/sdk/testing';
import { ResourceViewerPage } from '../components/ResourceViewerPage';
import { ThemeProvider } from '../../../contexts/ThemeContext';
import { renderWithProviders } from '../../../test-utils';
import type { LinkComponentProps } from '../../../contexts/RoutingContext';

// jsdom doesn't implement window.matchMedia — mock it for useTheme
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Shared, assertable spies: a per-call `vi.fn()` would be unobservable.
const announcements = vi.hoisted(() => ({
  announceResourceLoading: vi.fn(),
  announceResourceLoaded: vi.fn(),
}));

// The viewer is stood in so the content it is HANDED is observable without
// mounting CodeMirror or PDF.js; everything that loads content stays real.
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    ResourceViewer: ({ resource }: { resource: { content: string } }) => (
      <div data-testid="resource-viewer">{resource.content}</div>
    ),
    Toolbar: () => <div data-testid="toolbar">Toolbar</div>,
    useResourceLoadingAnnouncements: () => announcements,
  };
});

vi.mock('../../../contexts/ResourceAnnotationsContext', () => ({
  useResourceAnnotations: () => ({
    clearSparkle: vi.fn(),
    sparkleAnnotationIds: new Set<string>(),
    triggerSparkleAnimation: vi.fn(),
  }),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  announcements.announceResourceLoading.mockClear();
  announcements.announceResourceLoaded.mockClear();
});

/**
 * Mount the page for a resource whose bytes are really stored in the content
 * double. Returns the counters: representation fetches (`getBinary`),
 * media-token mints (`getMediaToken`) and arrival reports (`resourceViewed`).
 */
async function mountPageFor(mediaType: string, bytes: string) {
  const content = inMemoryContent();
  const { resourceId } = await content.putBinary({
    name: 'Fixture',
    file: new File([bytes], 'fixture', { type: mediaType }),
    format: mediaType,
    storageUri: 'file://fixture',
  });
  const getBinary = vi.spyOn(content, 'getBinary');
  const getMediaToken = vi.fn().mockResolvedValue({ token: 'tok-1' });

  const { session, client, storage } = createTestSession({
    gateway: { ...stubGateway(), getMediaToken },
    content,
  });
  const resourceViewed = vi.spyOn(client.browse, 'resourceViewed');
  const browser = new SemiontBrowser({ storage, sessionFactory: () => session });
  browser.activeSession$.next(session);
  browser.activeSignals$.next(new SessionSignals());
  cleanups.push(async () => {
    await browser.dispose();
    client.dispose();
  });

  const resource: ResourceDescriptor = {
    '@context': 'https://www.w3.org/ns/anno.jsonld',
    '@id': resourceId,
    '@type': 'schema:DigitalDocument',
    name: 'Fixture',
    archived: false,
    representations: [
      { '@type': 'schema:MediaObject', mediaType, byteSize: bytes.length },
    ],
  };

  renderWithProviders(
    <ThemeProvider>
      <ResourceViewerPage
        resource={resource}
        rUri={resourceId}
        locale="en"
        Link={({ href, children }: LinkComponentProps) => <a href={href}>{children}</a>}
        routes={{ resourceDetail: (id: string) => `/know/resource/${id}`, knowledge: () => '/know' }}
        ToolbarPanels={() => null}
        refetchDocument={vi.fn().mockResolvedValue(undefined)}
        streamStatus="open"
      />
    </ThemeProvider>,
    { browser },
  );

  return { resourceId, client, getBinary, getMediaToken, resourceViewed };
}

/** Let every already-started fetch settle, so a late duplicate is counted. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const viewerContent = () => screen.getByTestId('resource-viewer').textContent;

describe('ResourceViewerPage — one owner of content loading', () => {
  it('a PDF is never fetched as a representation: its bytes travel by the media-token URL', async () => {
    const { resourceId, client, getBinary, getMediaToken } =
      await mountPageFor('application/pdf', '%PDF-1.7 fixture bytes');

    const url = `${client.baseUrl}/api/resources/${resourceId}?token=tok-1`;
    await waitFor(() => expect(viewerContent()).toBe(url));
    await settle();

    expect(getBinary).toHaveBeenCalledTimes(0);
    expect(getMediaToken).toHaveBeenCalledTimes(1);
  });

  it('a text resource is fetched exactly once, and mints no media token', async () => {
    const { getBinary, getMediaToken } = await mountPageFor('text/plain', 'hello');

    await waitFor(() => expect(viewerContent()).toBe('hello'));
    await settle();

    expect(getBinary).toHaveBeenCalledTimes(1);
    expect(getMediaToken).toHaveBeenCalledTimes(0);
  });
});

// The viewer mounts its no-preview fallback for every `render: 'none'` type and
// for a registry miss, and that fallback reads no content: its download link
// mints its own token. So the page has nothing to load for any of these.
describe('ResourceViewerPage — a type with no preview loads nothing', () => {
  it.each([
    ['application/zip', 'an archive'],
    ['image/gif', 'a storage-tier image'],
    ['text/csv', 'decodable text the viewer does not render'],
    ['text/x-custom', 'a registry miss'],
  ])('%s (%s): no representation fetch, no media token', async (mediaType) => {
    const { getBinary, getMediaToken } = await mountPageFor(mediaType, 'fixture bytes');

    await screen.findByTestId('resource-viewer');
    await settle();

    expect(getBinary).toHaveBeenCalledTimes(0);
    expect(getMediaToken).toHaveBeenCalledTimes(0);
    expect(viewerContent()).toBe('');
  });

  // Nothing to wait for is not the same as never loaded: the fallback is on
  // screen at once, so the arrival is announced and reported like any other.
  it('still counts as loaded: announced, and reported viewed once', async () => {
    const { resourceId, resourceViewed } = await mountPageFor('application/zip', 'fixture bytes');

    await screen.findByTestId('resource-viewer');
    await settle();

    expect(announcements.announceResourceLoaded).toHaveBeenCalledWith('Fixture');
    expect(resourceViewed).toHaveBeenCalledTimes(1);
    expect(resourceViewed).toHaveBeenCalledWith(resourceId);
  });
});
