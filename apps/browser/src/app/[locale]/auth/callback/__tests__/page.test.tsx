/**
 * The issuer's return: the page completes the pending sign-in exactly once,
 * reports a knowledge base that is not the one the user clicked, and lands
 * them in the knowledge section — or on the auth error page with the reason.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { IdentityUnverifiableError, SignInError } from '@semiont/sdk';

const { mockReplace, mockCompleteSignIn, mockShowWarning, mockShowError } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockCompleteSignIn: vi.fn(),
  mockShowWarning: vi.fn(),
  mockShowError: vi.fn(),
}));

vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'KnowledgeBasePanel.connectedToOther') return `Connected to ${params?.actual}, not ${params?.expected}.`;
      if (key === 'KnowledgeBasePanel.identityCheckFailed') return 'Signed in, but the identity check could not reach this knowledge base.';
      if (key === 'KnowledgeBasePanel.identityNotReported') return 'Signed in, but this knowledge base did not report an identity.';
      if (key === 'KnowledgeBasePanel.unknownName') return 'Unknown';
      if (key === 'KnowledgeBasePanel.signingIn') return 'Signing in...';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('@semiont/react-ui', () => ({
  useSemiont: () => ({ completeSignIn: mockCompleteSignIn }),
  useToast: () => ({ showWarning: mockShowWarning, showError: mockShowError }),
}));

import AuthCallback from '../page';

const KB = { id: 'kb-1', did: 'did:web:caselaw.example', label: 'Caselaw Knowledge Base', email: 'a@b.c', endpoint: { kind: 'http', host: 'localhost', port: 4000, protocol: 'http' } };

describe('AuthCallback', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockCompleteSignIn.mockReset();
    mockShowWarning.mockReset();
    mockShowError.mockReset();
  });

  it('completes the sign-in from the current URL exactly once, even under StrictMode, then lands in the knowledge section', async () => {
    mockCompleteSignIn.mockResolvedValue({ kb: KB });

    render(<React.StrictMode><AuthCallback /></React.StrictMode>);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/know/discover'));
    expect(mockCompleteSignIn).toHaveBeenCalledTimes(1);
    expect(mockCompleteSignIn).toHaveBeenCalledWith(window.location.href);
    expect(mockShowWarning).not.toHaveBeenCalled();
  });

  it('reports when the knowledge base reached is not the one whose row was clicked (C) — and still lands', async () => {
    mockCompleteSignIn.mockResolvedValue({ kb: KB, expected: { did: 'did:web:synthetic.example', name: 'Synthetic Family' } });

    render(<AuthCallback />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/know/discover'));
    expect(mockShowWarning).toHaveBeenCalledWith('Connected to Caselaw Knowledge Base, not Synthetic Family.');
  });

  it('stays silent when the did matches what was clicked', async () => {
    mockCompleteSignIn.mockResolvedValue({ kb: KB, expected: { did: KB.did, name: KB.label } });

    render(<AuthCallback />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockShowWarning).not.toHaveBeenCalled();
  });

  it('distinguishes an unreachable identity check from a KB that reports none, and lands without registering', async () => {
    mockCompleteSignIn.mockResolvedValue(undefined);
    mockCompleteSignIn.mockRejectedValueOnce(new IdentityUnverifiableError('not-reported', 'status reported no did'));

    render(<AuthCallback />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/know/discover'));
    expect(mockShowError).toHaveBeenCalledWith(expect.stringMatching(/did not report an identity/i));
  });

  it.each([
    ['denied', 'AccessDenied'],
    ['no-issuer', 'Configuration'],
    ['discovery', 'Configuration'],
    ['state', 'Verification'],
    ['exchange', 'Verification'],
  ] as const)('routes a %s failure to the auth error page as %s', async (code, reason) => {
    mockCompleteSignIn.mockRejectedValue(new SignInError(code, 'no'));

    render(<AuthCallback />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/auth/error?error=${reason}`));
    expect(mockShowWarning).not.toHaveBeenCalled();
  });
});
