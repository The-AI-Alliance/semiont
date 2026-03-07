import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ResourceInfoPanel } from '../ResourceInfoPanel';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../../contexts/EventBusContext';

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      locale: 'Locale',
      notSpecified: 'Not specified',
      entityTypeTags: 'Entity Type Tags',
      representation: 'Representation',
      mediaType: 'Media Type',
      byteSize: 'Size',
      clone: 'Clone',
      cloneDescription: 'Generate a shareable clone link for this resource',
      archive: 'Archive',
      archiveDescription: 'Move this resource to archived status',
      unarchive: 'Unarchive',
      unarchiveDescription: 'Restore this resource to active status',
    };
    return translations[key] || key;
  }),
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock @semiont/api-client utilities
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    formatLocaleDisplay: vi.fn((locale: string) => `Language: ${locale}`),
  };
});

// Mock button styles
vi.mock('@/lib/button-styles', () => ({
  buttonStyles: {
    secondary: {
      base: 'px-4 py-2 rounded-lg font-medium',
    },
  },
}));

// Composition-based event tracker
interface TrackedEvent {
  event: string;
  payload: any;
}

function createEventTracker() {
  const events: TrackedEvent[] = [];

  function EventTrackingWrapper({ children }: { children: React.ReactNode }) {
    const eventBus = useEventBus();

    React.useEffect(() => {
      const handlers: Array<() => void> = [];

      // Track resource-related events
      const trackEvent = (eventName: string) => (payload: any) => {
        events.push({ event: eventName, payload });
      };

      const resourceEvents = [
        'yield:clone',
        'mark:archive',
        'mark:unarchive',
      ] as const;

      resourceEvents.forEach(eventName => {
        const handler = trackEvent(eventName);
        const subscription = eventBus.get(eventName).subscribe(handler);
        handlers.push(subscription);
      });

      return () => {
        handlers.forEach(sub => sub.unsubscribe());
      };
    }, [eventBus]);

    return <>{children}</>;
  }

  return {
    EventTrackingWrapper,
    events,
    clear: () => {
      events.length = 0;
    },
  };
}

// Helper to render with EventBusProvider
const renderWithEventBus = (component: React.ReactElement, tracker?: ReturnType<typeof createEventTracker>) => {
  if (tracker) {
    return render(
      <EventBusProvider>
        <tracker.EventTrackingWrapper>
          {component}
        </tracker.EventTrackingWrapper>
      </EventBusProvider>
    );
  }

  return render(
    <EventBusProvider>
      {component}
    </EventBusProvider>
  );
};

describe('ResourceInfoPanel Component', () => {
  const defaultProps = {
    documentEntityTypes: [],
    documentLocale: undefined,
    primaryMediaType: undefined,
    primaryByteSize: undefined,
  };

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render locale section', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} />);
      expect(screen.getByText('Locale')).toBeInTheDocument();
    });

    it('should render locale when provided', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} documentLocale="en-US" />);
      // formatLocaleDisplay is mocked to return "Language: {locale}"
      expect(screen.getByText('Language: en-US')).toBeInTheDocument();
    });

    it('should show "not specified" when locale is undefined', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} documentLocale={undefined} />);
      expect(screen.getByText('Not specified')).toBeInTheDocument();
    });

    it('should render entity type tags when provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          documentEntityTypes={['Person', 'Organization', 'Location']}
        />
      );

      expect(screen.getByText('Entity Type Tags')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
    });

    it('should not render entity type tags section when empty', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} documentEntityTypes={[]} />);
      expect(screen.queryByText('Entity Type Tags')).not.toBeInTheDocument();
    });

    it('should render representation section when media type provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          primaryMediaType="text/markdown"
        />
      );

      expect(screen.getByText('Representation')).toBeInTheDocument();
      expect(screen.getByText('Media Type')).toBeInTheDocument();
      expect(screen.getByText('text/markdown')).toBeInTheDocument();
    });

    it('should render byte size when provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          primaryByteSize={1024}
        />
      );

      expect(screen.getByText('Representation')).toBeInTheDocument();
      expect(screen.getByText('Size')).toBeInTheDocument();
      expect(screen.getByText('1,024 bytes')).toBeInTheDocument();
    });

    it('should not render representation section when neither media type nor byte size provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          primaryMediaType={undefined}
          primaryByteSize={undefined}
        />
      );

      expect(screen.queryByText('Representation')).not.toBeInTheDocument();
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = renderWithEventBus(<ResourceInfoPanel {...defaultProps} />);
      expect(container.querySelector('.semiont-resource-info-panel')).toBeInTheDocument();
    });

    it('should style entity type tags appropriately', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          documentEntityTypes={['TestType']}
        />
      );

      const tag = screen.getByText('TestType');
      expect(tag).toHaveClass('semiont-tag');
      expect(tag).toHaveAttribute('data-variant', 'blue');
    });
  });

  describe('Accessibility', () => {
    it('should have semantic heading structure', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          documentLocale="en-US"
          documentEntityTypes={['Person']}
        />
      );

      const headings = screen.getAllByRole('heading', { level: 3 });
      expect(headings.length).toBeGreaterThan(0);
    });
  });

  describe('Clone Action', () => {
    it('should render clone button', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
        />
      );

      expect(screen.getByRole('button', { name: /Clone/i })).toBeInTheDocument();
      expect(screen.getByText('Generate a shareable clone link for this resource')).toBeInTheDocument();
    });

    it('should emit yield:clone event when clone button clicked', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
        />,
        tracker
      );

      const button = screen.getByRole('button', { name: /Clone/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'yield:clone')).toBe(true);
      });
    });
  });

  describe('Archive Actions', () => {
    it('should render archive button when not archived', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={false}
        />
      );

      expect(screen.getByRole('button', { name: /Archive/i })).toBeInTheDocument();
      expect(screen.getByText('Move this resource to archived status')).toBeInTheDocument();
    });

    it('should render unarchive button when archived', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={true}
        />
      );

      expect(screen.getByRole('button', { name: /Unarchive/i })).toBeInTheDocument();
      expect(screen.getByText('Restore this resource to active status')).toBeInTheDocument();
    });

    it('should emit mark:archive event when archive button clicked', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={false}
        />,
        tracker
      );

      const button = screen.getByRole('button', { name: /Archive/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'mark:archive')).toBe(true);
      });
    });

    it('should emit mark:unarchive event when unarchive button clicked', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={true}
        />,
        tracker
      );

      const button = screen.getByRole('button', { name: /Unarchive/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'mark:unarchive')).toBe(true);
      });
    });
  });
});
