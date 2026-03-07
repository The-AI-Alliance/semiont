import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../test-utils';

// Mock the hooks and utilities that SessionExpiryBanner imports from @semiont/react-ui
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    useSessionExpiry: vi.fn(),
    formatTime: vi.fn(),
  };
});

import { useSessionExpiry, formatTime } from '@semiont/react-ui';
import type { MockedFunction } from 'vitest';
import { SessionExpiryBanner } from '../SessionExpiryBanner';

const mockUseSessionExpiry = useSessionExpiry as MockedFunction<typeof useSessionExpiry>;
const mockFormatTime = formatTime as MockedFunction<typeof formatTime>;

describe('SessionExpiryBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when session is not expiring soon', () => {
    mockUseSessionExpiry.mockReturnValue({
      timeRemaining: 600000,
      isExpiringSoon: false,
    });
    mockFormatTime.mockReturnValue('10m');

    const { container } = renderWithProviders(<SessionExpiryBanner />);

    expect(container.firstChild).toBeNull();
  });

  it('should return null when formatTime returns null', () => {
    mockUseSessionExpiry.mockReturnValue({
      timeRemaining: 0,
      isExpiringSoon: true,
    });
    mockFormatTime.mockReturnValue(null);

    const { container } = renderWithProviders(<SessionExpiryBanner />);

    expect(container.firstChild).toBeNull();
  });

  it('should render banner with time remaining when expiring soon', () => {
    mockUseSessionExpiry.mockReturnValue({
      timeRemaining: 180000,
      isExpiringSoon: true,
    });
    mockFormatTime.mockReturnValue('3m');

    renderWithProviders(<SessionExpiryBanner />);

    expect(screen.getByText(/Session expiring soon/)).toBeInTheDocument();
    expect(screen.getByText(/3m remaining/)).toBeInTheDocument();
  });

  it('should hide banner when dismiss button is clicked', () => {
    mockUseSessionExpiry.mockReturnValue({
      timeRemaining: 180000,
      isExpiringSoon: true,
    });
    mockFormatTime.mockReturnValue('3m');

    renderWithProviders(<SessionExpiryBanner />);

    // Banner is visible
    expect(screen.getByText(/Session expiring soon/)).toBeInTheDocument();

    // Click dismiss
    const dismissButton = screen.getByLabelText('Dismiss warning');
    fireEvent.click(dismissButton);

    // Banner should be gone
    expect(screen.queryByText(/Session expiring soon/)).not.toBeInTheDocument();
  });

  it('should have role="alert"', () => {
    mockUseSessionExpiry.mockReturnValue({
      timeRemaining: 180000,
      isExpiringSoon: true,
    });
    mockFormatTime.mockReturnValue('3m');

    renderWithProviders(<SessionExpiryBanner />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should have aria-live="polite"', () => {
    mockUseSessionExpiry.mockReturnValue({
      timeRemaining: 180000,
      isExpiringSoon: true,
    });
    mockFormatTime.mockReturnValue('3m');

    renderWithProviders(<SessionExpiryBanner />);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('should have data-visible attribute when shown', () => {
    mockUseSessionExpiry.mockReturnValue({
      timeRemaining: 60000,
      isExpiringSoon: true,
    });
    mockFormatTime.mockReturnValue('1m');

    renderWithProviders(<SessionExpiryBanner />);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-visible', 'true');
  });
});
