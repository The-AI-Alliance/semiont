/**
 * The "Download File" affordance on the unsupported-media fallback, in BOTH
 * resource views.
 *
 * `GET /api/resources/:id` is the browser-facing alias of the pipe, and it
 * exists only as an auth affordance for `<img>`, PDF.js and download links: a
 * plain `<a download href>` sends neither an Authorization header nor a cookie,
 * so the alias takes bearer + `?token=` only. Both views shipped a bare
 * `/api/resources/${id}` — tokenless, so a 401, AND relative, so under
 * bring-your-own-session embedding it resolves against the HOST app's origin
 * rather than the gateway's.
 *
 * Started RED (both hrefs were `/api/resources/res-1`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { AnnotationUIState } from '../../../types/annotation-props';
import { AnnotateView } from '../AnnotateView';
import { BrowseView } from '../BrowseView';

vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));
vi.mock('../../CodeMirrorRenderer', () => ({ CodeMirrorRenderer: () => null }));
vi.mock('../../image-annotation/SvgDrawingCanvas', () => ({ SvgDrawingCanvas: () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

const GATEWAY = 'http://gateway.test:4000';
const UNSUPPORTED = 'application/octet-stream';

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };
const uiState: AnnotationUIState = {
  selectedMotivation: null,
  selectedClick: 'detail',
  selectedShape: 'rectangle',
  hoveredAnnotationId: null,
  scrollToAnnotationId: null,
};

/** A session whose client mints `token` — the batteries-included case. */
function sessionMinting(token: string): SemiontSession {
  return fakeSession({ auth: { mediaToken: vi.fn(async () => ({ token })) } });
}

/** A session whose token request never settles — the in-flight case. */
function sessionPending(): SemiontSession {
  return fakeSession({ auth: { mediaToken: vi.fn(() => new Promise<never>(() => {})) } });
}

/**
 * A transport-only client: `SemiontClient.auth` is `AuthNamespace | undefined`,
 * and a host wiring a bare transport (no `IGatewayOperations`) has no `auth`.
 */
function sessionWithoutAuth(): SemiontSession {
  return fakeSession({});
}

function fakeSession(clientExtras: Record<string, unknown>): SemiontSession {
  return {
    client: {
      baseUrl: GATEWAY,
      mark: { request: vi.fn() },
      browse: { click: vi.fn() },
      beckon: { hover: vi.fn() },
      ...clientExtras,
    },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

const annotateProps = (session: SemiontSession) => ({
  content: '',
  mimeType: UNSUPPORTED,
  resourceUri: 'res-1',
  annotations: emptyAnnotations,
  uiState,
  annotateMode: false,
  session,
});

const browseProps = (session: SemiontSession) => ({
  content: '',
  mimeType: UNSUPPORTED,
  resourceUri: 'res-1',
  annotations: emptyAnnotations,
  annotateMode: false,
  session,
});

const VIEWS = [
  { name: 'AnnotateView', render: (s: SemiontSession) => render(<AnnotateView {...annotateProps(s)} />) },
  { name: 'BrowseView', render: (s: SemiontSession) => render(<BrowseView {...browseProps(s)} />) },
] as const;

describe.each(VIEWS)('$name — unsupported-media download link', ({ render: renderView }) => {
  it('points at the gateway origin and carries the media token', async () => {
    renderView(sessionMinting('tok-abc'));

    const link = await screen.findByRole('link', { name: 'Download File' });
    expect(link).toHaveAttribute('href', `${GATEWAY}/api/resources/res-1?token=tok-abc`);
    expect(link).toHaveAttribute('download');
  });

  it('renders no href while the token is still in flight', async () => {
    renderView(sessionPending());

    // The affordance stays on screen — it is just not yet actionable. What it
    // must NOT do is offer a URL already known to fail.
    expect(await screen.findByText('Download File')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download File' })).not.toBeInTheDocument();
  });

  it('renders no href when the client has no auth namespace', async () => {
    renderView(sessionWithoutAuth());

    expect(await screen.findByText('Download File')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Download File' })).not.toBeInTheDocument();
    });
  });

  it('never builds a host-relative URL', async () => {
    renderView(sessionMinting('tok-abc'));

    const link = await screen.findByRole('link', { name: 'Download File' });
    expect(link.getAttribute('href')).not.toMatch(/^\//);
  });
});
