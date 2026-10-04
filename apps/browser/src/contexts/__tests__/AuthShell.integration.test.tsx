/**
 * AuthShell Integration Smoke Test
 *
 * Exercises the full chain end-to-end (in jsdom):
 *
 *   localStorage seeded with a KB + token
 *     → fresh SemiontBrowser constructs SemiontSession for the active KB
 *     → session asks the gateway who the stored token is
 *     → on 401: session clears token + raises sessionEnded$
 *     → SessionEndedModal (mounted by AuthShell) reads sessionEnded$
 *        and renders, in the copy react-ui ships for the locale
 *
 * If any link in this chain breaks, the user sees an empty page instead of
 * the modal. This is the integration the unit tests miss.
 *
 * Nothing inside `@semiont/sdk` is mocked: the gateway and the issuer are a
 * `fetch` stub. Asking who a token is is one request to `/api/users/me`
 * (`whoIs`). Refresh is the refresh grant at the issuer the stored session
 * names, keyed on that endpoint — every other fetch (the transport's event
 * stream) is refused.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';
import { SemiontProvider, TranslationProvider, WebBrowserStorage } from '@semiont/react-ui';
import { englishTranslationManager } from '@semiont/react-ui/test-utils';
import { SemiontBrowser, createHttpSessionFactory } from '@semiont/sdk';
import en from '@semiont/react-ui/translations/en';

// The shell is mounted under react-ui's own English, and the copy is read
// from there, never retyped.
const copy = en.SessionEndedModal;
// Set up in beforeEach; tests script what each answers.
const whoIs = vi.fn<(request: Request) => Promise<Response>>();
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
const alice = async (): Promise<Response> =>
  Response.json({ did: 'did:web:example.org:users:alice', email: 'alice@example.com', name: 'Alice', image: null, domain: 'example.org' });
const refused = async (): Promise<Response> => new Response(null, { status: 401 });

const TOKEN_ENDPOINT = 'https://issuer.test/realms/semiont/protocol/openid-connect/token';
const issuerReply = (json: unknown, status = 200): Response =>
  ({ ok: status < 300, status, json: async () => json }) as unknown as Response;
const refreshCalls = () => fetchMock.mock.calls.filter(([url]) => url === TOKEN_ENDPOINT);

// Mock @headlessui/react to avoid jsdom portal issues
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

// Build a fake JWT whose `exp` is far in the future, so validation runs.
function makeFakeJwt(): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${header}.${payload}.sig`;
}

const KB_ID = 'kb-1';
const KB = {
  id: KB_ID,
  label: 'Test',
  // A registered KB carries its identity: `did` is required, and
  // `loadKnowledgeBases` FILTERS OUT stored entries without one (a knowledge
  // base declares its identity or does not run). Omit this and the seeded KB
  // is dropped at load, the browser holds zero KBs, no session is constructed,
  // and every assertion in this file fails as "expected `me` to be called" —
  // the symptom is three layers from the cause. Typed fixtures catch this at
  // `tsc`; this one is seeded as JSON, so only the suite can.
  did: 'did:web:example.github.io:test-kb',
  endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
};

import { AuthShell } from '../AuthShell';

function seedSession(access: string, refresh: string) {
  localStorage.setItem(
    `semiont.session.${KB_ID}`,
    JSON.stringify({ access, refresh, clientId: 'semiont-browser', tokenEndpoint: TOKEN_ENDPOINT }),
  );
}

function renderShell(children: React.ReactNode) {
  const browser = new SemiontBrowser({
    storage: new WebBrowserStorage(),
    sessionFactory: createHttpSessionFactory(),
  });
  return {
    browser,
    ...render(
      <MemoryRouter>
        <TranslationProvider translationManager={englishTranslationManager}>
          <SemiontProvider browser={browser}>
            <AuthShell>{children}</AuthShell>
          </SemiontProvider>
        </TranslationProvider>
      </MemoryRouter>
    ),
  };
}

describe('AuthShell integration — KB session validation → modal', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('semiont.knowledgeBases', JSON.stringify([KB]));
    localStorage.setItem('semiont.activeKnowledgeBaseId', KB_ID);
    seedSession(makeFakeJwt(), makeFakeJwt());

    whoIs.mockReset();
    fetchMock = vi.fn(async (_url: string) => issuerReply({ error: 'invalid_grant' }, 400));
    vi.stubGlobal('fetch', (input: string | Request, init?: RequestInit) =>
      input instanceof Request && new URL(input.url).pathname === '/api/users/me'
        ? whoIs(input)
        : fetchMock(input instanceof Request ? input.url : input, init));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders children and no modal when the gateway says who the token is', async () => {
    whoIs.mockImplementation(alice);

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => {
      expect(whoIs).toHaveBeenCalled();
    });

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
    expect(localStorage.getItem(`semiont.session.${KB_ID}`)).not.toBeNull();

    await browser.dispose();
  });

  it('surfaces SessionEndedModal when the gateway refuses the token and the issuer will not renew it', async () => {
    whoIs.mockImplementation(refused);
    // The issuer refuses the refresh grant — the stub's default.

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => {
      expect(screen.getByText(copy.title)).toBeInTheDocument();
    });

    expect(screen.getByText(copy.expired)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.signInAgain })).toBeInTheDocument();
    expect(localStorage.getItem(`semiont.session.${KB_ID}`)).toBeNull();
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();

    await browser.dispose();
  });

  it('asks twice and says so when the gateway refuses a token the issuer has just renewed', async () => {
    // The storm one tab made: an issuer that goes on renewing, and a gateway
    // that refuses whatever it issues.
    whoIs.mockImplementation(refused);
    fetchMock.mockImplementation(async (url: string) =>
      url === TOKEN_ENDPOINT ? issuerReply({ access_token: makeFakeJwt() }) : issuerReply({ error: 'invalid_grant' }, 400));

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => {
      expect(screen.getByText(copy.refused)).toBeInTheDocument();
    });

    expect(whoIs).toHaveBeenCalledTimes(2);
    // The title is true of either ending: the expiry sentence is not shown.
    expect(screen.getByText(copy.title)).toBeInTheDocument();
    expect(screen.queryByText(copy.expired)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.signInAgain })).toBeInTheDocument();
    expect(localStorage.getItem(`semiont.session.${KB_ID}`)).toBeNull();

    await browser.dispose();
  });

  it('does NOT surface SessionEndedModal when the gateway fails with 500', async () => {
    whoIs.mockImplementation(async () => new Response(null, { status: 500 }));

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => {
      expect(whoIs).toHaveBeenCalled();
    });

    expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
    expect(localStorage.getItem(`semiont.session.${KB_ID}`)).not.toBeNull();
    expect(refreshCalls()).toHaveLength(0);

    await browser.dispose();
  });

  it('recovers transparently when the gateway refuses the token and accepts the renewed one', async () => {
    const newAccess = makeFakeJwt();
    whoIs.mockImplementationOnce(refused).mockImplementationOnce(alice);
    fetchMock.mockImplementation(async (url: string) =>
      url === TOKEN_ENDPOINT ? issuerReply({ access_token: newAccess }) : issuerReply({ error: 'invalid_grant' }, 400));

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => expect(whoIs).toHaveBeenCalledTimes(2));
    expect(refreshCalls()).toHaveLength(1);
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(`semiont.session.${KB_ID}`)!);
    expect(stored.access).toBe(newAccess);

    await browser.dispose();
  });
});
