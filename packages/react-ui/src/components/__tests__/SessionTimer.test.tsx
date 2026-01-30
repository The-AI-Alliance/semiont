import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionTimer } from '../SessionTimer';

// Mock the hooks
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    useSessionExpiry: vi.fn(),
    useFormattedTime: vi.fn(),
  };
});

import { useSessionExpiry, useFormattedTime } from '@semiont/react-ui';

describe('SessionTimer', () => {
  describe('Rendering', () => {
    it('should render formatted time when available', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 300000 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('5:00');

      render(<SessionTimer />);

      expect(screen.getByText(/Session:/)).toBeInTheDocument();
      expect(screen.getByText(/5:00 remaining/)).toBeInTheDocument();
    });

    it('should have correct class name', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 300000 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('5:00');

      const { container } = render(<SessionTimer />);

      expect(container.querySelector('.semiont-session-timer')).toBeInTheDocument();
    });

    it('should display complete message with formatted time', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 120000 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('2:00');

      render(<SessionTimer />);

      const element = screen.getByText('Session: 2:00 remaining');
      expect(element).toBeInTheDocument();
    });
  });

  describe('Null Cases', () => {
    it('should return null when formattedTime is null', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 0 } as any);
      vi.mocked(useFormattedTime).mockReturnValue(null);

      const { container } = render(<SessionTimer />);

      expect(container.firstChild).toBeNull();
    });

    it('should return null when formattedTime is undefined', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 0 } as any);
      vi.mocked(useFormattedTime).mockReturnValue(undefined as any);

      const { container } = render(<SessionTimer />);

      expect(container.firstChild).toBeNull();
    });

    it('should return null when formattedTime is empty string', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 0 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('');

      const { container } = render(<SessionTimer />);

      expect(container.firstChild).toBeNull();
    });
  });

  describe('Hook Integration', () => {
    it('should call useSessionExpiry hook', () => {
      const mockUseSessionExpiry = vi.mocked(useSessionExpiry);
      mockUseSessionExpiry.mockReturnValue({ timeRemaining: 100000 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('1:40');

      render(<SessionTimer />);

      expect(mockUseSessionExpiry).toHaveBeenCalled();
    });

    it('should call useFormattedTime with timeRemaining', () => {
      const mockUseFormattedTime = vi.mocked(useFormattedTime);
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 300000 } as any);
      mockUseFormattedTime.mockReturnValue('5:00');

      render(<SessionTimer />);

      expect(mockUseFormattedTime).toHaveBeenCalledWith(300000);
    });

    it('should pass correct timeRemaining to useFormattedTime', () => {
      const mockUseFormattedTime = vi.mocked(useFormattedTime);
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 12345 } as any);
      mockUseFormattedTime.mockReturnValue('0:12');

      render(<SessionTimer />);

      expect(mockUseFormattedTime).toHaveBeenCalledWith(12345);
    });
  });

  describe('Different Time Values', () => {
    it('should display different formatted times correctly', () => {
      const testCases = [
        { timeRemaining: 60000, formatted: '1:00' },
        { timeRemaining: 3600000, formatted: '60:00' },
        { timeRemaining: 30000, formatted: '0:30' },
        { timeRemaining: 5000, formatted: '0:05' },
      ];

      testCases.forEach(({ timeRemaining, formatted }) => {
        vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining } as any);
        vi.mocked(useFormattedTime).mockReturnValue(formatted);

        const { unmount } = render(<SessionTimer />);

        expect(screen.getByText(`Session: ${formatted} remaining`)).toBeInTheDocument();

        unmount();
      });
    });
  });

  describe('Re-rendering', () => {
    it('should update when timeRemaining changes', () => {
      const mockUseSessionExpiry = vi.mocked(useSessionExpiry);
      const mockUseFormattedTime = vi.mocked(useFormattedTime);

      mockUseSessionExpiry.mockReturnValue({ timeRemaining: 60000 } as any);
      mockUseFormattedTime.mockReturnValue('1:00');

      const { rerender } = render(<SessionTimer />);
      expect(screen.getByText('Session: 1:00 remaining')).toBeInTheDocument();

      // Simulate time passing
      mockUseSessionExpiry.mockReturnValue({ timeRemaining: 30000 } as any);
      mockUseFormattedTime.mockReturnValue('0:30');

      rerender(<SessionTimer />);
      expect(screen.getByText('Session: 0:30 remaining')).toBeInTheDocument();
    });

    it('should hide when formattedTime becomes null', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 60000 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('1:00');

      const { container, rerender } = render(<SessionTimer />);
      expect(screen.getByText('Session: 1:00 remaining')).toBeInTheDocument();

      // Time expires
      vi.mocked(useFormattedTime).mockReturnValue(null);

      rerender(<SessionTimer />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero timeRemaining', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 0 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('0:00');

      render(<SessionTimer />);

      expect(screen.getByText('Session: 0:00 remaining')).toBeInTheDocument();
    });

    it('should handle negative timeRemaining', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: -1000 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('expired');

      render(<SessionTimer />);

      expect(screen.getByText('Session: expired remaining')).toBeInTheDocument();
    });

    it('should handle very large timeRemaining', () => {
      vi.mocked(useSessionExpiry).mockReturnValue({ timeRemaining: 999999999 } as any);
      vi.mocked(useFormattedTime).mockReturnValue('16666:39');

      render(<SessionTimer />);

      expect(screen.getByText(/16666:39/)).toBeInTheDocument();
    });
  });
});
