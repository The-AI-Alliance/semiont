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
 * We spy on `SemiontClient.prototype.getMe` / `refreshToken` rather than
 * replacing the class, because `SemiontSession` constructs `SemiontClient`
 * via an internal reference inside `@semiont/api-client`'s bundle — a
 * package-level `vi.mock` would not intercept that. Prototype-level spies
 * patch every instance regardless of where it's constructed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { SemiontProvider, WebBrowserStorage } from '@semiont/react-ui';
import { SemiontBrowser, SemiontClient } from '@semiont/sdk';
import { APIError } from '@semiont/api-client';
// Spies set up in beforeEach; tests configure `.mockResolvedValue` / `.mockRejectedValue` on them.
let getMeSpy: ReturnType<typeof vi.spyOn>;
let refreshTokenSpy: ReturnType<typeof vi.spyOn>;

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
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'test@example.com',
};

import { AuthShell } from '../AuthShell';

function seedSession(access: string, refresh: string) {
  localStorage.setItem(
    `semiont.session.${KB_ID}`,
    JSON.stringify({ access, refresh }),
  );
}

function renderShell(children: React.ReactNode) {
  const browser = new SemiontBrowser({ storage: new WebBrowserStorage() });
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
    getMeSpy = vi.spyOn(SemiontClient.prototype, 'getMe');
    refreshTokenSpy = vi.spyOn(SemiontClient.prototype, 'refreshToken');
  });

  afterEach(() => {
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
    refreshTokenSpy.mockRejectedValue(new APIError('Invalid', 401, 'Unauthorized'));

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
    expect(refreshTokenSpy).not.toHaveBeenCalled();

    await browser.dispose();
  });

  it('recovers transparently when getMe returns 401 but refresh succeeds', async () => {
    const newAccess = makeFakeJwt();
    getMeSpy
      .mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'))
      .mockResolvedValueOnce({ email: 'alice@example.com' } as any);
    refreshTokenSpy.mockResolvedValueOnce({ access_token: newAccess } as any);

    const { browser } = renderShell(
      <div data-testid="protected-content">protected</div>
    );

    await waitFor(() => expect(getMeSpy).toHaveBeenCalledTimes(2));
    expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(`semiont.session.${KB_ID}`)!);
    expect(stored.access).toBe(newAccess);

    await browser.dispose();
  });
});
