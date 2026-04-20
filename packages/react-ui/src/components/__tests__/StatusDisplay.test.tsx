import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../test-utils';
import { StatusDisplay } from '../StatusDisplay';

let mockGetStatus: ReturnType<typeof vi.fn>;
const stableMockClient = {
  get getStatus() { return mockGetStatus; },
};
const stableMockSession = { client: stableMockClient };
const stableActiveSession$ = new BehaviorSubject<any>(stableMockSession);
const stableMockBrowser = { activeSession$: stableActiveSession$ };

vi.mock('../../session/SemiontProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session/SemiontProvider')>();
  return {
    ...actual,
    useSemiont: () => stableMockBrowser,
  };
});

describe('StatusDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatus = vi.fn();
  });

  it('should show "Authentication required" when not fully authenticated', () => {
    mockGetStatus.mockResolvedValue({ status: 'healthy', version: '1.0.0' });

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={false} />
    );

    expect(screen.getByText(/Authentication required/)).toBeInTheDocument();
  });

  it('should show status when data is available', async () => {
    mockGetStatus.mockResolvedValue({ status: 'healthy', version: '1.2.3' });

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    await waitFor(() => {
      expect(screen.getByText(/healthy/)).toBeInTheDocument();
      expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
    });
  });

  it('should show "Connection failed" on error', async () => {
    mockGetStatus.mockRejectedValue(new Error('Network error'));

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    await waitFor(() => {
      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
    });
  });

  it('should show re-login message for 401 errors', async () => {
    mockGetStatus.mockRejectedValue(new Error('401 Unauthorized'));

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    await waitFor(() => {
      expect(screen.getByText(/sign out and sign in again/i)).toBeInTheDocument();
    });
  });

  it('should show warning for authenticated users missing backend token', () => {
    mockGetStatus.mockResolvedValue(undefined);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={true} hasValidBackendToken={false} />
    );

    expect(screen.getByText(/sign out and sign in again to reconnect/i)).toBeInTheDocument();
  });

  it('should have role="status"', () => {
    mockGetStatus.mockResolvedValue(undefined);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={false} />
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('should have aria-live="polite"', () => {
    mockGetStatus.mockResolvedValue(undefined);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={false} />
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('should show sign-in hint when not authenticated', () => {
    mockGetStatus.mockResolvedValue(undefined);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={false} />
    );

    expect(screen.getByText('Sign in to view backend status')).toBeInTheDocument();
  });

  it('should show error hint when there is an error', async () => {
    mockGetStatus.mockRejectedValue(new Error('Connection refused'));

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    await waitFor(() => {
      expect(screen.getByText(/Check that the backend server is running/)).toBeInTheDocument();
    });
  });

  it('should set data-status attribute based on state', async () => {
    mockGetStatus.mockResolvedValue({ status: 'healthy', version: '1.0.0' });

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    await waitFor(() => {
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('data-status', 'success');
    });
  });
});
