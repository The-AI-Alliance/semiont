/**
 * AuthShell Integration Smoke Test
 *
 * Exercises the full chain end-to-end (in jsdom):
 *
 *   localStorage seeded with a KB + token
 *     → fresh SemiontBrowser constructs SemiontSession for the active KB
 *     → session validates token via getMe
 *     → on 401: session clears token + sets sessionExpiredAt$
 *     → SessionExpiredModal (mounted by AuthShell) reads sessionExpiredAt$
 *        and renders
 *
 * If any link in this chain breaks, the user sees an empty page instead of
 * the modal. This is the integration the unit tests miss.
 *
 * We spy on `AuthNamespace.prototype.me` rather than replacing the class,
 * because `SemiontSession` constructs `SemiontClient` via an internal
 * reference inside `@semiont/sdk`'s bundle — a package-level `vi.mock`
 * would not intercept that. Prototype-level spies patch every instance
 * regardless of where it's constructed. Refresh is the refresh grant at the
 * issuer the stored session names, so it is a `fetch` stub keyed on that
 * endpoint — every other fetch (the transport's event stream) is refused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';
import { SemiontProvider, WebBrowserStorage } from '@semiont/react-ui';
import { SemiontBrowser, AuthNamespace, createHttpSessionFactory } from '@semiont/sdk';
import { APIError } from '@semiont/http-transport';
// Set up in beforeEach; tests configure `.mockResolvedValue` / `.mockRejectedValue` on them.
let getMeSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

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
  email: 'test@example.com',
  // A registered KB carries its identity: `did` is required, and
  // `loadKnowledgeBases` FILTERS OUT stored entries without one
  // (KB-IDENTITY-VS-ADDRESS decision 8 — a knowledge base declares its
  // identity or does not run). Omit this and the seeded KB is dropped at
  // load, the browser holds zero KBs, no session is constructed, and every
  // assertion in this file fails as "expected `me` to be called" — the
  // symptom is three layers from the cause. Typed fixtures catch this at
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
        <SemiontProvider browser={browser}>
          <AuthShell>{children}</AuthShell>
        </SemiontProvider>
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

    // Patch the real client's prototype. Applies to every SemiontClient
    // constructed during the test, including the throwaway clients that
    // `SemiontSession.validate` spins up.
    getMeSpy = vi.spyOn(AuthNamespace.prototype, 'me');
    fetchMock = vi.fn(async (_url: string) => issuerReply({ error: 'invalid_grant' }, 400));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders children and no modal when getMe succeeds', async () => {
    getMeSpy.mockResolvedValue({ email: 'alice@example.com' } as any);

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => {
      expect(getMeSpy).toHaveBeenCalled();
    });

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    expect(localStorage.getItem(`semiont.session.${KB_ID}`)).not.toBeNull();

    await browser.dispose();
  });

  it('surfaces SessionExpiredModal when getMe AND refresh both fail with 401', async () => {
    getMeSpy.mockRejectedValue(new APIError('Unauthorized', 401, 'Unauthorized'));
    // The issuer refuses the refresh grant — the stub's default.

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => {
      expect(screen.getByText('Session Expired')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /sign in again/i })).toBeInTheDocument();
    expect(localStorage.getItem(`semiont.session.${KB_ID}`)).toBeNull();
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();

    await browser.dispose();
  });

  it('does NOT surface SessionExpiredModal when getMe fails with 500', async () => {
    getMeSpy.mockRejectedValue(new APIError('Server error', 500, 'Internal Server Error'));

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => {
      expect(getMeSpy).toHaveBeenCalled();
    });

    expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    expect(localStorage.getItem(`semiont.session.${KB_ID}`)).not.toBeNull();
    expect(refreshCalls()).toHaveLength(0);

    await browser.dispose();
  });

  it('recovers transparently when getMe returns 401 but refresh succeeds', async () => {
    const newAccess = makeFakeJwt();
    getMeSpy
      .mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'))
      .mockResolvedValueOnce({ email: 'alice@example.com' } as any);
    fetchMock.mockImplementation(async (url: string) =>
      url === TOKEN_ENDPOINT ? issuerReply({ access_token: newAccess }) : issuerReply({ error: 'invalid_grant' }, 400));

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => expect(getMeSpy).toHaveBeenCalledTimes(2));
    expect(refreshCalls()).toHaveLength(1);
    expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(`semiont.session.${KB_ID}`)!);
    expect(stored.access).toBe(newAccess);

    await browser.dispose();
  });
});
