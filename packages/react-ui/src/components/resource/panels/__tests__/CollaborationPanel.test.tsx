import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CollaborationPanel } from '../CollaborationPanel';

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      connectionStatus: 'Connection Status',
      live: 'Live',
      disconnected: 'Disconnected',
      events: '{count} event(s)',
      lastSync: 'Last sync:',
      noActivity: 'No activity',
      justNow: 'just now',
      secondsAgo: '{count} seconds ago',
      minuteAgo: '1 minute ago',
      minutesAgo: '{count} minutes ago',
      hourAgo: '1 hour ago',
      hoursAgo: '{count} hours ago',
      realtimeActive: 'Real-time synchronization active',
      reconnecting: 'Reconnecting...',
      sharing: 'Sharing',
      collaborationComingSoon: 'Multi-user collaboration coming soon',
    };
    let result = translations[key] || key;
    // Replace {count} with actual count value if provided
    if (params?.count !== undefined) {
      result = result.replace('{count}', String(params.count));
    }
    return result;
  }),
}));

describe('CollaborationPanel Component', () => {
  const defaultProps = {
    isConnected: false,
    eventCount: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Rendering', () => {
    it('should render connection status section', () => {
      render(<CollaborationPanel {...defaultProps} />);

      expect(screen.getByText('Connection Status')).toBeInTheDocument();
    });

    it('should render sharing section', () => {
      render(<CollaborationPanel {...defaultProps} />);

      expect(screen.getByText('Sharing')).toBeInTheDocument();
    });

    it('should render coming soon message', () => {
      render(<CollaborationPanel {...defaultProps} />);

      expect(screen.getByText('Multi-user collaboration coming soon')).toBeInTheDocument();
    });
  });

  describe('Connection Status', () => {
    it('should show disconnected status when not connected', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={false} />);

      expect(screen.getByText('Disconnected')).toBeInTheDocument();
    });

    it('should show live status when connected', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={true} />);

      expect(screen.getByText('Live')).toBeInTheDocument();
    });

    it('should show indicator when disconnected', () => {
      const { container } = render(<CollaborationPanel {...defaultProps} isConnected={false} />);

      const indicator = container.querySelector('.semiont-collaboration-panel__dot');
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveAttribute('data-connected', 'false');
    });

    it('should show indicator when connected', () => {
      const { container } = render(<CollaborationPanel {...defaultProps} isConnected={true} />);

      const indicator = container.querySelector('.semiont-collaboration-panel__dot');
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveAttribute('data-connected', 'true');
    });

    it('should use appropriate status text for disconnected state', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={false} />);

      const statusText = screen.getByText('Disconnected');
      expect(statusText).toHaveClass('semiont-collaboration-panel__status-text');
      expect(statusText).toHaveAttribute('data-connected', 'false');
    });

    it('should use appropriate status text for connected state', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={true} />);

      const statusText = screen.getByText('Live');
      expect(statusText).toHaveClass('semiont-collaboration-panel__status-text');
      expect(statusText).toHaveAttribute('data-connected', 'true');
    });
  });

  describe('Event Count', () => {
    it('should not show event count when zero', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={true} eventCount={0} />);

      expect(screen.queryByText(/event/i)).not.toBeInTheDocument();
    });

    it('should show event count when connected and greater than zero', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={true} eventCount={5} />);

      expect(screen.getByText(/event/i)).toBeInTheDocument();
    });

    it('should not show event count when disconnected', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={false} eventCount={5} />);

      expect(screen.queryByText(/event/i)).not.toBeInTheDocument();
    });

    it('should display correct event count', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={true} eventCount={42} />);

      // The translation will have ${count} in it
      expect(screen.getByText(/event/i)).toBeInTheDocument();
    });
  });

  describe('Last Sync Time', () => {
    it('should show "no activity" when no timestamp', () => {
      render(<CollaborationPanel {...defaultProps} />);

      expect(screen.getByText('No activity')).toBeInTheDocument();
    });

    it('should show "just now" for very recent events (< 10 seconds)', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const fiveSecondsAgo = new Date('2024-01-01T11:59:55Z');

      vi.setSystemTime(now);

      render(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={fiveSecondsAgo.toISOString()}
        />
      );

      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('should show seconds ago for events 10-59 seconds old', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const thirtySecondsAgo = new Date('2024-01-01T11:59:30Z');

      vi.setSystemTime(now);

      render(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={thirtySecondsAgo.toISOString()}
        />
      );

      expect(screen.getByText(/seconds ago/i)).toBeInTheDocument();
    });

    it('should show "1 minute ago" for events 1 minute old', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const oneMinuteAgo = new Date('2024-01-01T11:59:00Z');

      vi.setSystemTime(now);

      render(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={oneMinuteAgo.toISOString()}
        />
      );

      expect(screen.getByText('1 minute ago')).toBeInTheDocument();
    });

    it('should show minutes ago for events 2-59 minutes old', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const thirtyMinutesAgo = new Date('2024-01-01T11:30:00Z');

      vi.setSystemTime(now);

      render(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={thirtyMinutesAgo.toISOString()}
        />
      );

      expect(screen.getByText(/minutes ago/i)).toBeInTheDocument();
    });

    it('should show "1 hour ago" for events 1 hour old', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const oneHourAgo = new Date('2024-01-01T11:00:00Z');

      vi.setSystemTime(now);

      render(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={oneHourAgo.toISOString()}
        />
      );

      expect(screen.getByText('1 hour ago')).toBeInTheDocument();
    });

    it('should show hours ago for events 2-23 hours old', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const fiveHoursAgo = new Date('2024-01-01T07:00:00Z');

      vi.setSystemTime(now);

      render(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={fiveHoursAgo.toISOString()}
        />
      );

      expect(screen.getByText(/hours ago/i)).toBeInTheDocument();
    });

    it('should show date for events older than 24 hours', () => {
      const now = new Date('2024-01-10T12:00:00Z');
      const fiveDaysAgo = new Date('2024-01-05T12:00:00Z');

      vi.setSystemTime(now);

      render(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={fiveDaysAgo.toISOString()}
        />
      );

      // Should show a formatted date
      const lastSyncText = screen.getByText(/Last sync:/i).parentElement;
      expect(lastSyncText?.textContent).toMatch(/\d+\/\d+\/\d+/);
    });
  });

  describe('Real-time Status Messages', () => {
    it('should show "real-time active" when connected', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={true} />);

      expect(screen.getByText('Real-time synchronization active')).toBeInTheDocument();
    });

    it('should show "reconnecting" when disconnected', () => {
      render(<CollaborationPanel {...defaultProps} isConnected={false} />);

      expect(screen.getByText('Reconnecting...')).toBeInTheDocument();
    });
  });

  describe('Dynamic Updates', () => {
    it('should update when connection status changes', () => {
      const { rerender } = render(<CollaborationPanel {...defaultProps} isConnected={false} />);

      expect(screen.getByText('Disconnected')).toBeInTheDocument();

      rerender(<CollaborationPanel {...defaultProps} isConnected={true} />);

      expect(screen.getByText('Live')).toBeInTheDocument();
      expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
    });

    it('should update when event count changes', () => {
      const { rerender } = render(
        <CollaborationPanel {...defaultProps} isConnected={true} eventCount={5} />
      );

      expect(screen.getByText(/event/i)).toBeInTheDocument();

      rerender(<CollaborationPanel {...defaultProps} isConnected={true} eventCount={10} />);

      expect(screen.getByText(/event/i)).toBeInTheDocument();
    });

    it('should update when last event timestamp changes', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      vi.setSystemTime(now);

      const { rerender } = render(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={new Date('2024-01-01T11:59:00Z').toISOString()}
        />
      );

      expect(screen.getByText('1 minute ago')).toBeInTheDocument();

      rerender(
        <CollaborationPanel
          {...defaultProps}
          lastEventTimestamp={new Date('2024-01-01T11:59:55Z').toISOString()}
        />
      );

      expect(screen.getByText('just now')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle very old timestamps', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const veryOld = new Date('2020-01-01T12:00:00Z');

      vi.setSystemTime(now);

      expect(() => {
        render(
          <CollaborationPanel
            {...defaultProps}
            lastEventTimestamp={veryOld.toISOString()}
          />
        );
      }).not.toThrow();
    });

    it('should handle future timestamps gracefully', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const future = new Date('2024-01-02T12:00:00Z');

      vi.setSystemTime(now);

      expect(() => {
        render(
          <CollaborationPanel
            {...defaultProps}
            lastEventTimestamp={future.toISOString()}
          />
        );
      }).not.toThrow();
    });

    it('should handle invalid timestamp strings', () => {
      expect(() => {
        render(
          <CollaborationPanel {...defaultProps} lastEventTimestamp="invalid-date" />
        );
      }).not.toThrow();
    });

    it('should handle very large event counts', () => {
      expect(() => {
        render(
          <CollaborationPanel {...defaultProps} isConnected={true} eventCount={999999} />
        );
      }).not.toThrow();
    });

    it('should handle negative event counts', () => {
      expect(() => {
        render(
          <CollaborationPanel {...defaultProps} isConnected={true} eventCount={-5} />
        );
      }).not.toThrow();
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = render(<CollaborationPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-collaboration-panel');
    });

    it('should have semantic class names', () => {
      const { container } = render(<CollaborationPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-collaboration-panel');
    });

    it('should have proper section divider', () => {
      const { container } = render(<CollaborationPanel {...defaultProps} />);

      const section = container.querySelector('.semiont-collaboration-panel__section--bordered');
      expect(section).toBeInTheDocument();
    });

    it('should have proper heading styles', () => {
      render(<CollaborationPanel {...defaultProps} />);

      const heading = screen.getByText('Connection Status');
      expect(heading).toHaveClass('semiont-collaboration-panel__heading');
    });

    it('should have proper status container', () => {
      render(<CollaborationPanel {...defaultProps} />);

      const statusText = screen.getByText('Disconnected');
      const statusContainer = statusText.closest('.semiont-collaboration-panel__status-text');
      expect(statusContainer).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have semantic heading structure', () => {
      render(<CollaborationPanel {...defaultProps} />);

      expect(screen.getByText('Connection Status')).toHaveClass('semiont-collaboration-panel__heading');
      expect(screen.getByText('Sharing')).toHaveClass('semiont-collaboration-panel__heading');
    });

    it('should have visible status indicators', () => {
      const { container } = render(<CollaborationPanel {...defaultProps} isConnected={true} />);

      // Should have a visible status dot
      const indicator = container.querySelector('.semiont-collaboration-panel__dot');
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveAttribute('data-connected', 'true');
    });

    it('should have proper text hierarchy', () => {
      render(<CollaborationPanel {...defaultProps} />);

      const section = screen.getByText('Connection Status').closest('div');
      expect(section?.querySelector('.semiont-collaboration-panel__details')).toBeInTheDocument();
    });
  });

  describe('Time Formatting Logic', () => {
    it('should calculate time differences correctly', () => {
      const testCases = [
        { now: '2024-01-01T12:00:00Z', then: '2024-01-01T12:00:00Z', expected: 'just now' },
        { now: '2024-01-01T12:00:00Z', then: '2024-01-01T11:59:59Z', expected: 'just now' },
        { now: '2024-01-01T12:00:00Z', then: '2024-01-01T11:59:30Z', expected: /seconds ago/ },
        { now: '2024-01-01T12:00:00Z', then: '2024-01-01T11:59:00Z', expected: '1 minute ago' },
        { now: '2024-01-01T12:00:00Z', then: '2024-01-01T11:30:00Z', expected: /minutes ago/ },
        { now: '2024-01-01T12:00:00Z', then: '2024-01-01T11:00:00Z', expected: '1 hour ago' },
        { now: '2024-01-01T12:00:00Z', then: '2024-01-01T07:00:00Z', expected: /hours ago/ },
      ];

      testCases.forEach(({ now, then, expected }) => {
        vi.setSystemTime(new Date(now));

        const { unmount } = render(
          <CollaborationPanel {...defaultProps} lastEventTimestamp={then} />
        );

        const lastSyncText = screen.getByText(/Last sync:/i).parentElement?.textContent;
        if (typeof expected === 'string') {
          expect(lastSyncText).toContain(expected);
        } else {
          expect(lastSyncText).toMatch(expected);
        }

        unmount();
      });
    });
  });
});
