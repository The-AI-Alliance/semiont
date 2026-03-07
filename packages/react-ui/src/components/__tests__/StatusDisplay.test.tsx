import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../test-utils';

// Mock api-hooks
vi.mock('../../lib/api-hooks', () => ({
  useHealth: vi.fn(),
}));

import { useHealth } from '../../lib/api-hooks';
import type { MockedFunction } from 'vitest';
import { StatusDisplay } from '../StatusDisplay';

const mockUseHealth = useHealth as MockedFunction<typeof useHealth>;

function createMockHealth(queryResult: { data?: unknown; isLoading?: boolean; error?: unknown }) {
  return {
    check: {
      useQuery: vi.fn(),
    },
    status: {
      useQuery: vi.fn().mockReturnValue({
        data: queryResult.data ?? undefined,
        isLoading: queryResult.isLoading ?? false,
        error: queryResult.error ?? undefined,
      }),
    },
  };
}

describe('StatusDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show "Authentication required" when not fully authenticated', () => {
    mockUseHealth.mockReturnValue(createMockHealth({ data: undefined, isLoading: false }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={false} />
    );

    expect(screen.getByText(/Authentication required/)).toBeInTheDocument();
  });

  it('should show "Connecting..." when loading', () => {
    mockUseHealth.mockReturnValue(createMockHealth({ isLoading: true }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    expect(screen.getByText(/Connecting\.\.\./)).toBeInTheDocument();
  });

  it('should show status when data is available', () => {
    mockUseHealth.mockReturnValue(createMockHealth({
      data: { status: 'healthy', version: '1.2.3' },
    }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    expect(screen.getByText(/healthy/)).toBeInTheDocument();
    expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
  });

  it('should show "Connection failed" on error', () => {
    mockUseHealth.mockReturnValue(createMockHealth({
      error: new Error('Network error'),
    }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
  });

  it('should show re-login message for 401 errors', () => {
    mockUseHealth.mockReturnValue(createMockHealth({
      error: new Error('401 Unauthorized'),
    }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    expect(screen.getByText(/sign out and sign in again/i)).toBeInTheDocument();
  });

  it('should show warning for authenticated users missing backend token', () => {
    mockUseHealth.mockReturnValue(createMockHealth({ data: undefined }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={true} hasValidBackendToken={false} />
    );

    expect(screen.getByText(/sign out and sign in again to reconnect/i)).toBeInTheDocument();
  });

  it('should have role="status"', () => {
    mockUseHealth.mockReturnValue(createMockHealth({ data: undefined }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={false} />
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('should have aria-live="polite"', () => {
    mockUseHealth.mockReturnValue(createMockHealth({ data: undefined }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={false} />
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('should show sign-in hint when not authenticated', () => {
    mockUseHealth.mockReturnValue(createMockHealth({ data: undefined }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={false} isAuthenticated={false} />
    );

    expect(screen.getByText('Sign in to view backend status')).toBeInTheDocument();
  });

  it('should show error hint when there is an error', () => {
    mockUseHealth.mockReturnValue(createMockHealth({
      error: new Error('Connection refused'),
    }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    expect(screen.getByText(/Check that the backend server is running/)).toBeInTheDocument();
  });

  it('should set data-status attribute based on state', () => {
    mockUseHealth.mockReturnValue(createMockHealth({
      data: { status: 'healthy', version: '1.0.0' },
    }) as ReturnType<typeof useHealth>);

    renderWithProviders(
      <StatusDisplay isFullyAuthenticated={true} isAuthenticated={true} hasValidBackendToken={true} />
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-status', 'success');
  });
});
