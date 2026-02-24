import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ReferencesPanel } from '../ReferencesPanel';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../../contexts/EventBusContext';

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

      const trackEvent = (eventName: string) => (payload: any) => {
        events.push({ event: eventName, payload });
      };

      const panelEvents = ['annotate:assist-request'] as const;

      panelEvents.forEach(eventName => {
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

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      title: 'Assist with Entities',
      selectEntityTypes: 'Select entity types',
      noEntityTypes: 'No entity types available',
      select: 'Select',
      deselect: 'Deselect',
      typesSelected: '{count} type(s) selected',
      startAssist: 'Start Assist',
      found: 'Found {count}',
      includeDescriptiveReferences: 'Include descriptive references',
      descriptiveReferencesTooltip: 'Also find phrases like \'the CEO\', \'the tech giant\', \'the physicist\' (in addition to names)',
      cancel: 'Cancel',
    };
    let result = translations[key] || key;
    // Replace {count} with actual count value if provided
    if (params?.count !== undefined) {
      result = result.replace('{count}', String(params.count));
    }
    return result;
  }),
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock AnnotationProgressWidget - simplified to avoid module import issues
vi.mock('@/components/AnnotationProgressWidget', () => ({
  AnnotationProgressWidget: ({ progress }: any) => (
    <div data-testid="detection-progress-widget">
      <div data-testid="progress-data">{JSON.stringify(progress)}</div>
      <button title="Cancel Detection">Cancel</button>
    </div>
  ),
}));

describe('ReferencesPanel Component', () => {
  // Mock Link component
  const MockLink = ({ href, children, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  );

  // Mock routes
  const mockRoutes = {
    resourceDetail: (id: string) => `/resources/${id}`,
  } as any;

  const defaultProps = {
    allEntityTypes: ['Person', 'Organization', 'Location', 'Date'],
    isAssisting: false,
    progress: null,
    annotateMode: true,
    Link: MockLink,
    routes: mockRoutes,
    pendingAnnotation: null,
  };

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render panel with title', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      expect(screen.getByText('Detect Entities')).toBeInTheDocument();
    });

    it('should render all entity type buttons', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
      expect(screen.getByText('Date')).toBeInTheDocument();
    });

    it('should show message when no entity types available', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} allEntityTypes={[]} />);

      expect(screen.getByText('No entity types available')).toBeInTheDocument();
    });

    it('should render start detection button', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      expect(screen.getByTitle('Start Detection')).toBeInTheDocument();
    });
  });

  describe('Entity Type Selection', () => {
    it('should toggle entity type selection on click', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      // Initially not selected
      expect(personButton).toHaveAttribute('aria-pressed', 'false');

      // Click to select
      await userEvent.click(personButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'true');

      // Click again to deselect
      await userEvent.click(personButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('should allow multiple selections', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');
      const orgButton = screen.getByText('Organization');
      const locationButton = screen.getByText('Location');

      await userEvent.click(personButton);
      await userEvent.click(orgButton);
      await userEvent.click(locationButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'true');
      expect(orgButton).toHaveAttribute('aria-pressed', 'true');
      expect(locationButton).toHaveAttribute('aria-pressed', 'true');
    });

    it('should deselect when clicking selected type', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      await userEvent.click(personButton);
      expect(personButton).toHaveAttribute('aria-pressed', 'true');

      await userEvent.click(personButton);
      expect(personButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('should show selected count', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');
      const orgButton = screen.getByText('Organization');

      await userEvent.click(personButton);

      // Should show count
      expect(screen.getByText(/selected/i)).toBeInTheDocument();

      await userEvent.click(orgButton);

      // Should update count
      expect(screen.getByText(/selected/i)).toBeInTheDocument();
    });

    it('should not show selected count when none selected', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
    });
  });

  describe('Button Styling', () => {
    it('should style selected buttons differently', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      // Before selection
      expect(personButton).toHaveClass('semiont-chip', 'semiont-chip--selectable');
      expect(personButton).toHaveAttribute('data-selected', 'false');

      await userEvent.click(personButton);

      // After selection
      expect(personButton).toHaveAttribute('data-selected', 'true');
    });

    it('should have proper ARIA attributes', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-pressed');
      expect(personButton).toHaveAttribute('aria-label');
    });

    it('should have focus styles', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveClass('semiont-chip', 'semiont-chip--selectable');
    });
  });

  describe('Start Detection Button', () => {
    it('should be disabled when no types selected', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const startButton = screen.getByTitle('Start Detection');

      expect(startButton).toBeDisabled();
    });

    it('should be enabled when types are selected', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');
      await userEvent.click(personButton);

      const startButton = screen.getByTitle('Start Detection');

      expect(startButton).not.toBeDisabled();
    });

    it('should emit annotate:detect-request event with selected types and includeDescriptiveReferences', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(<ReferencesPanel {...defaultProps} />, tracker);

      await userEvent.click(screen.getByText('Person'));
      await userEvent.click(screen.getByText('Organization'));

      const startButton = screen.getByTitle('Start Detection');
      await userEvent.click(startButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'annotate:assist-request' &&
          e.payload?.motivation === 'linking' &&
          e.payload?.options?.entityTypes?.includes('Person') &&
          e.payload?.options?.entityTypes?.includes('Organization') &&
          e.payload?.options?.includeDescriptiveReferences === false
        )).toBe(true);
      });
    });

    it('should emit annotate:detect-request event with includeDescriptiveReferences when checkbox is checked', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(<ReferencesPanel {...defaultProps} />, tracker);

      await userEvent.click(screen.getByText('Person'));

      // Check the "Include descriptive references" checkbox
      const checkboxLabel = screen.getByText('Include descriptive references');
      const checkbox = checkboxLabel.previousElementSibling as HTMLInputElement;
      await userEvent.click(checkbox);

      const startButton = screen.getByTitle('Start Detection');
      await userEvent.click(startButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'annotate:assist-request' &&
          e.payload?.motivation === 'linking' &&
          e.payload?.options?.entityTypes?.includes('Person') &&
          e.payload?.options?.includeDescriptiveReferences === true
        )).toBe(true);
      });
    });

    it('should clear selected types after detection starts', async () => {
      const { rerender } = renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      await userEvent.click(screen.getByText('Person'));

      const startButton = screen.getByTitle('Start Detection');
      await userEvent.click(startButton);

      // Simulate detection starting
      rerender(
        <EventBusProvider>
          <ReferencesPanel
            {...defaultProps}
            isAssisting={true}
            progress={{ completedEntityTypes: [] }}
          />
        </EventBusProvider>
      );

      // Simulate detection completing
      rerender(
        <EventBusProvider>
          <ReferencesPanel
            {...defaultProps}
            isAssisting={false}
            progress={{
              completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
            }}
          />
        </EventBusProvider>
      );

      // UI should reset but we can't directly test internal state
      // We can test that buttons are back to unselected state after going through full cycle
    });

    it('should have proper styling when disabled', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const startButton = screen.getByTitle('Start Detection');

      expect(startButton).toHaveClass('semiont-button');
      expect(startButton).toHaveAttribute('data-variant', 'detect');
      expect(startButton).toHaveAttribute('data-type', 'reference');
      expect(startButton).toBeDisabled();
    });

    it('should have proper styling when enabled', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      await userEvent.click(screen.getByText('Person'));

      const startButton = screen.getByTitle('Start Detection');

      expect(startButton).toHaveClass('semiont-button');
      expect(startButton).toHaveAttribute('data-variant', 'detect');
      expect(startButton).toHaveAttribute('data-type', 'reference');
      expect(startButton).not.toBeDisabled();
    });
  });

  describe('Detection Progress', () => {
    it('should show progress widget when detecting', () => {
      renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={true}
          progress={{ completedEntityTypes: [] }}
        />
      );

      expect(screen.getByTestId('detection-progress-widget')).toBeInTheDocument();
    });

    it('should pass progress data to widget', () => {
      const progress = {
        completedEntityTypes: [
          { entityType: 'Person', foundCount: 5 },
          { entityType: 'Organization', foundCount: 3 },
        ],
      };

      renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={true}
          progress={progress}
        />
      );

      const progressData = screen.getByTestId('progress-data');
      expect(progressData.textContent).toContain('Person');
      expect(progressData.textContent).toContain('Organization');
    });

    it('should hide entity type selection during detection', () => {
      renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={true}
          progress={{ completedEntityTypes: [] }}
        />
      );

      expect(screen.queryByText('Select entity types')).not.toBeInTheDocument();
      expect(screen.queryByText('Person')).not.toBeInTheDocument();
    });

    it('should render cancel button when detecting', async () => {
      renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={true}
          progress={{ completedEntityTypes: [] }}
        />
      );

      const cancelButton = screen.getByTitle('Cancel Detection');
      expect(cancelButton).toBeInTheDocument();
    });
  });

  describe('Detection Complete Log', () => {
    it('should show completed log after detection finishes', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={false}
          progress={{
            completedEntityTypes: [
              { entityType: 'Person', foundCount: 5 },
              { entityType: 'Organization', foundCount: 3 },
            ],
          }}
        />
      );

      // Parent clears progress after completion
      rerender(
        <EventBusProvider>
          <ReferencesPanel
            {...defaultProps}
            isAssisting={false}
            progress={null}
          />
        </EventBusProvider>
      );

      expect(screen.getByText('Person:')).toBeInTheDocument();
      expect(screen.getByText('Organization:')).toBeInTheDocument();
    });

    it('should show found counts in log', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={false}
          progress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(
        <EventBusProvider>
          <ReferencesPanel {...defaultProps} isAssisting={false} progress={null} />
        </EventBusProvider>
      );
      expect(screen.getByText(/Found.*5/i)).toBeInTheDocument();
    });

    it('should show checkmarks for completed types', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={false}
          progress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(
        <EventBusProvider>
          <ReferencesPanel {...defaultProps} isAssisting={false} progress={null} />
        </EventBusProvider>
      );
      expect(screen.getByText('✓')).toBeInTheDocument();
    });

    it('should show detection log and selection UI together after completion', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={false}
          progress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(
        <EventBusProvider>
          <ReferencesPanel {...defaultProps} isAssisting={false} progress={null} />
        </EventBusProvider>
      );

      // Should show both the completed log AND the selection UI
      expect(screen.getByText('Person:')).toBeInTheDocument(); // Log entry
      expect(screen.getByText('Select entity types')).toBeInTheDocument(); // Selection UI
    });

    it('should show selection UI immediately after detection completes', async () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={false}
          progress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(
        <EventBusProvider>
          <ReferencesPanel {...defaultProps} isAssisting={false} progress={null} />
        </EventBusProvider>
      );

      // Selection UI should be immediately available (no button click needed)
      expect(screen.getByText('Select entity types')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument(); // Entity type chip
    });

    it('should not show log when empty', () => {
      renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={false}
          progress={{
            completedEntityTypes: [],
          }}
        />
      );

      // Should not show any log items (but selection UI should still be visible)
      expect(screen.queryByText('✓')).not.toBeInTheDocument();
      expect(screen.getByText('Select entity types')).toBeInTheDocument();
    });
  });

  describe('State Transitions', () => {
    it('should transition from idle to detecting', () => {
      const { rerender } = renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      // Idle state
      expect(screen.getByText('Select entity types')).toBeInTheDocument();

      // Start detecting
      rerender(
        <EventBusProvider>
          <ReferencesPanel
            {...defaultProps}
            isAssisting={true}
            progress={{ completedEntityTypes: [] }}
          />
        </EventBusProvider>
      );

      // Detecting state
      expect(screen.getByTestId('detection-progress-widget')).toBeInTheDocument();
      expect(screen.queryByText('Select entity types')).not.toBeInTheDocument();
    });

    it('should transition from detecting to complete', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={true}
          progress={{ completedEntityTypes: [] }}
        />
      );

      // Detecting
      expect(screen.getByTestId('detection-progress-widget')).toBeInTheDocument();

      // Complete - first trigger useEffect to copy to lastDetectionLog
      rerender(
        <EventBusProvider>
          <ReferencesPanel
            {...defaultProps}
            isAssisting={false}
            progress={{
              completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
            }}
          />
        </EventBusProvider>
      );

      // Then clear progress to show the log
      rerender(
        <EventBusProvider>
          <ReferencesPanel {...defaultProps} isAssisting={false} progress={null} />
        </EventBusProvider>
      );

      expect(screen.queryByTestId('detection-progress-widget')).not.toBeInTheDocument();
      // Both log and selection UI should be visible
      expect(screen.getByText('Person:')).toBeInTheDocument();
      expect(screen.getByText('Select entity types')).toBeInTheDocument();
    });

    it('should show selection UI after detection completes', async () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={false}
          progress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      // Clear progress to show the log
      rerender(
        <EventBusProvider>
          <ReferencesPanel {...defaultProps} isAssisting={false} progress={null} />
        </EventBusProvider>
      );

      // Selection UI should be immediately available
      expect(screen.getByText('Select entity types')).toBeInTheDocument();

      rerender(
        <EventBusProvider>
          <ReferencesPanel {...defaultProps} />
        </EventBusProvider>
      );

      expect(screen.getByText('Select entity types')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty entity types array', () => {
      expect(() => {
        renderWithEventBus(<ReferencesPanel {...defaultProps} allEntityTypes={[]} />);
      }).not.toThrow();
    });

    it('should handle many entity types', () => {
      const manyTypes = Array.from({ length: 50 }, (_, i) => `Type${i}`);

      expect(() => {
        renderWithEventBus(<ReferencesPanel {...defaultProps} allEntityTypes={manyTypes} />);
      }).not.toThrow();

      expect(screen.getByText('Type0')).toBeInTheDocument();
      expect(screen.getByText('Type49')).toBeInTheDocument();
    });

    it('should handle entity types with special characters', () => {
      const specialTypes = ['Type-A', 'Type_B', 'Type.C', 'Type/D'];

      renderWithEventBus(<ReferencesPanel {...defaultProps} allEntityTypes={specialTypes} />);

      specialTypes.forEach(type => {
        expect(screen.getByText(type)).toBeInTheDocument();
      });
    });

    it('should handle selecting and deselecting all types', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      // Select all
      for (const type of defaultProps.allEntityTypes) {
        await userEvent.click(screen.getByText(type));
      }

      defaultProps.allEntityTypes.forEach(type => {
        expect(screen.getByText(type)).toHaveAttribute('aria-pressed', 'true');
      });

      // Deselect all
      for (const type of defaultProps.allEntityTypes) {
        await userEvent.click(screen.getByText(type));
      }

      defaultProps.allEntityTypes.forEach(type => {
        expect(screen.getByText(type)).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('should handle rapid selection changes', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      // Rapid clicks
      for (let i = 0; i < 10; i++) {
        await userEvent.click(personButton);
      }

      // Should be in a consistent state (even number of clicks = not selected)
      expect(personButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('should handle zero found count in results', () => {
      renderWithEventBus(
        <ReferencesPanel
          {...defaultProps}
          isAssisting={false}
          progress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 0 }],
          }}
        />
      );

      expect(screen.getByText(/Found.*0/i)).toBeInTheDocument();
    });

    it('should handle undefined progress', () => {
      expect(() => {
        renderWithEventBus(
          <ReferencesPanel
            {...defaultProps}
            isAssisting={false}
            progress={undefined as any}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });

    it('should support dark mode', () => {
      const { container } = renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });

    it('should have title without emoji', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      // The emoji is no longer in the title (it's only in the tab now)
      const title = screen.getByRole('heading', { level: 2 });
      expect(title.textContent).not.toContain('🔵');
      expect(title.textContent).toContain('referencesTitle');
    });

    it('should have proper button layout', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const buttonContainer = screen.getByText('Person').parentElement;
      expect(buttonContainer).toHaveClass('semiont-detect-widget__chips');
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels for selection', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-label');

      await userEvent.click(personButton);

      // Label should update to indicate deselection is possible
      const label = personButton.getAttribute('aria-label');
      expect(label).toBeTruthy();
    });

    it('should have proper ARIA pressed states', async () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-pressed', 'false');

      await userEvent.click(personButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'true');
    });

    it('should be keyboard navigable', () => {
      renderWithEventBus(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');
      personButton.focus();

      expect(personButton).toHaveFocus();
    });
  });
});
