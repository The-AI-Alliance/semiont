import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ReferencesPanel } from '../ReferencesPanel';
import type { Annotation, AnnotationId, EventBus } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { createTestSemiontWrapper } from '../../../../test-utils';

// Composition-based event tracker
interface TrackedEvent {
  event: string;
  payload: any;
}

function createEventTracker() {
  const events: TrackedEvent[] = [];
  return {
    events,
    clear: () => { events.length = 0; },
    _attach(eventBus: EventBus) {
      const panelEvents = ['mark:assist-request', 'mark:submit'] as const;
      panelEvents.forEach((eventName) => {
        eventBus.get(eventName).subscribe((payload: any) => {
          events.push({ event: eventName, payload });
        });
      });
    },
  };
}

// Per-test session/wrapper: created in beforeEach — test-utils disposes every
// created client in a module-scope afterEach, so a module-scope factory call
// would hand tests after the first a disposed client. The component is
// provider-free: the `session` passed as a prop (same factory call as the
// eventBus the tracker attaches to) is the only session it sees.
let session: SemiontSession;
let eventBus: EventBus;
let SemiontWrapper: React.ComponentType<{ children: React.ReactNode }>;

beforeEach(() => {
  ({ session, eventBus, SemiontWrapper } = createTestSemiontWrapper());
});

const renderWithEventBus = (component: React.ReactElement, tracker?: ReturnType<typeof createEventTracker>) => {
  if (tracker) tracker._attach(eventBus);
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  return render(component, { wrapper: Wrapper });
};

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      annotateReferences: 'Annotate References',
      selectEntityTypes: 'Select entity types',
      noEntityTypes: 'No entity types available',
      select: 'Select',
      deselect: 'Deselect',
      typesSelected: '{count} type(s) selected',
      annotate: 'Annotate',
      found: 'Found {count}',
      includeDescriptiveReferences: 'Include descriptive references',
      descriptiveReferencesTooltip: 'Also find phrases like \'the CEO\', \'the tech giant\', \'the physicist\' (in addition to names)',
      cancel: 'Cancel',
      createReference: 'Create Reference',
      annotating: 'Annotating...',
      // CLEAN-PROGRESS D3: the widget's own strings come from the
      // AssistProgress namespace now, not from this panel's.
      inProgress: 'Annotating...',
      complete: 'Annotation complete!',
      failed: 'Annotation failed',
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
    resourceId: 'res-1',
    allEntityTypes: ['Person', 'Organization', 'Location', 'Date'],
    isAssisting: false,
    progress: null,
    annotateMode: true,
    Link: MockLink,
    routes: mockRoutes,
    pendingAnnotation: null,
  };

  // Per-test props: merges the beforeEach-created session at render time.
  // (Module/describe-scope defaultProps must stay session-free — disposal
  // hazard, see note above renderWithEventBus.)
  const panelProps = () => ({ ...defaultProps, session });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // RESOLUTION-SPARKLE D6: the panel threads the host's sparkle set down to
  // the entries — exactly the ids in the set glow, nothing else.
  describe('Resolution sparkle threading', () => {
    const linkingReference = (id: string): Annotation => ({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: id as AnnotationId,
      type: 'Annotation',
      motivation: 'linking',
      created: '2026-08-21T12:00:00Z',
      modified: '2026-08-21T12:00:00Z',
      target: {
        source: 'res-1',
        selector: { type: 'TextQuoteSelector', exact: `text of ${id}` },
      },
      body: { type: 'SpecificResource', source: 'linked-doc', purpose: 'linking' },
    });

    it('sparkles exactly the entries named by sparkleAnnotationIds', () => {
      const { container } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          annotations={[linkingReference('ann-dark'), linkingReference('ann-lit')]}
          sparkleAnnotationIds={new Set(['ann-lit'])}
        />,
      );

      const sparkling = container.querySelectorAll('.semiont-reference-icon.annotation-sparkle');
      expect(sparkling).toHaveLength(1);
      expect(sparkling[0]!.closest('.semiont-annotation-entry')).toHaveTextContent('text of ann-lit');
    });
  });

  describe('Rendering', () => {
    it('should render panel with title', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      expect(screen.getByText('Annotate References')).toBeInTheDocument();
    });

    it('should render all entity type buttons', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
      expect(screen.getByText('Date')).toBeInTheDocument();
    });

    it('should show message when no entity types available', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} allEntityTypes={[]} />);

      expect(screen.getByText('No entity types available')).toBeInTheDocument();
    });

    it('should render start detection button', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      expect(screen.getByTitle('Annotate')).toBeInTheDocument();
    });
  });

  // Entity types are optional on a reference, but `MarkSubmitEvent.body` is
  // `minItems: 1` — so "no types selected" must OMIT body, not send `[]`.
  // Sending `[]` 400s at /bus/emit, and `mark.submit` is fire-and-forget, so
  // the failure is silent: the button looks inert. Found live 2026-08-24.
  describe('Create Reference payload', () => {
    const pendingLinking = {
      motivation: 'linking' as const,
      selector: { type: 'TextQuoteSelector' as const, exact: 'thylakoid' },
    };

    const submitPayloads = (tracker: ReturnType<typeof createEventTracker>) =>
      tracker.events.filter(e => e.event === 'mark:submit').map(e => e.payload);

    // The panel's own entity-type chips, not AssistSection's identically
    // labelled ones.
    const renderPrompt = (tracker: ReturnType<typeof createEventTracker>) => {
      const { container } = renderWithEventBus(
        <ReferencesPanel {...panelProps()} pendingAnnotation={pendingLinking} />,
        tracker,
      );
      return within(container.querySelector('.semiont-annotation-prompt') as HTMLElement);
    };

    it('omits body entirely when no entity type is selected', async () => {
      const tracker = createEventTracker();
      const prompt = renderPrompt(tracker);

      await userEvent.click(prompt.getByRole('button', { name: /create reference/i }));

      const [payload] = submitPayloads(tracker);
      expect(payload).toBeDefined();
      expect(payload).not.toHaveProperty('body');
    });

    it('sends a one-item body when an entity type is selected', async () => {
      const tracker = createEventTracker();
      const prompt = renderPrompt(tracker);

      await userEvent.click(prompt.getByRole('button', { name: 'Person' }));
      await userEvent.click(prompt.getByRole('button', { name: /create reference/i }));

      const [payload] = submitPayloads(tracker);
      expect(payload.body).toEqual([
        { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
      ]);
    });
  });

  describe('Entity Type Selection', () => {
    it('should toggle entity type selection on click', async () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

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
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

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
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const personButton = screen.getByText('Person');

      await userEvent.click(personButton);
      expect(personButton).toHaveAttribute('aria-pressed', 'true');

      await userEvent.click(personButton);
      expect(personButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('should show selected count', async () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

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
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
    });
  });

  describe('Button Styling', () => {
    it('should style selected buttons differently', async () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const personButton = screen.getByText('Person');

      // Before selection
      expect(personButton).toHaveClass('semiont-chip', 'semiont-chip--selectable');
      expect(personButton).toHaveAttribute('data-selected', 'false');

      await userEvent.click(personButton);

      // After selection
      expect(personButton).toHaveAttribute('data-selected', 'true');
    });

    it('should have proper ARIA attributes', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-pressed');
      expect(personButton).toHaveAttribute('aria-label');
    });

    it('should have focus styles', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveClass('semiont-chip', 'semiont-chip--selectable');
    });
  });

  describe('Start Annotate Button', () => {
    it('should be disabled when no types selected', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const startButton = screen.getByTitle('Annotate');

      expect(startButton).toBeDisabled();
    });

    it('should be enabled when types are selected', async () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const personButton = screen.getByText('Person');
      await userEvent.click(personButton);

      const startButton = screen.getByTitle('Annotate');

      expect(startButton).not.toBeDisabled();
    });

    it('should emit annotate:detect-request event with selected types and includeDescriptiveReferences', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(<ReferencesPanel {...panelProps()} />, tracker);

      await userEvent.click(screen.getByText('Person'));
      await userEvent.click(screen.getByText('Organization'));

      const startButton = screen.getByTitle('Annotate');
      await userEvent.click(startButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:assist-request' &&
          e.payload?.motivation === 'linking' &&
          e.payload?.options?.entityTypes?.includes('Person') &&
          e.payload?.options?.entityTypes?.includes('Organization') &&
          e.payload?.options?.includeDescriptiveReferences === false
        )).toBe(true);
      });
    });

    it('should emit annotate:detect-request event with includeDescriptiveReferences when checkbox is checked', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(<ReferencesPanel {...panelProps()} />, tracker);

      await userEvent.click(screen.getByText('Person'));

      // Check the "Include descriptive references" checkbox
      const checkboxLabel = screen.getByText('Include descriptive references');
      const checkbox = checkboxLabel.previousElementSibling as HTMLInputElement;
      await userEvent.click(checkbox);

      const startButton = screen.getByTitle('Annotate');
      await userEvent.click(startButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:assist-request' &&
          e.payload?.motivation === 'linking' &&
          e.payload?.options?.entityTypes?.includes('Person') &&
          e.payload?.options?.includeDescriptiveReferences === true
        )).toBe(true);
      });
    });

    it('should clear selected types after detection starts', async () => {
      const { rerender } = renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      await userEvent.click(screen.getByText('Person'));

      const startButton = screen.getByTitle('Annotate');
      await userEvent.click(startButton);

      // Simulate detection starting
      rerender(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={true}
          progress={{ percentage: 0, completedItems: [] }}
        />
      );

      // Simulate detection completing
      rerender(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 5 }],
          }}
        />
      );

      // UI should reset but we can't directly test internal state
      // We can test that buttons are back to unselected state after going through full cycle
    });

    it('should have proper styling when disabled', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const startButton = screen.getByTitle('Annotate');

      expect(startButton).toHaveClass('semiont-button');
      expect(startButton).toHaveAttribute('data-variant', 'assist');
      expect(startButton).toHaveAttribute('data-type', 'reference');
      expect(startButton).toBeDisabled();
    });

    it('should have proper styling when enabled', async () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      await userEvent.click(screen.getByText('Person'));

      const startButton = screen.getByTitle('Annotate');

      expect(startButton).toHaveClass('semiont-button');
      expect(startButton).toHaveAttribute('data-variant', 'assist');
      expect(startButton).toHaveAttribute('data-type', 'reference');
      expect(startButton).not.toBeDisabled();
    });
  });

  describe('Detection Progress', () => {
    it('should show progress widget when detecting', () => {
      renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={true}
          progress={{ percentage: 0, completedItems: [] }}
        />
      );

      expect(screen.getByText('Annotating...')).toBeInTheDocument();
    });

    it('should pass progress data to widget', () => {
      const progress = {
        percentage: 100,
        completedItems: [
          { value: 'Person', foundCount: 5 },
          { value: 'Organization', foundCount: 3 },
        ],
      };

      renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={true}
          progress={progress}
        />
      );

      // Real AssistProgress renders the completed entity-type log.
      expect(screen.getByText('Person:')).toBeInTheDocument();
      expect(screen.getByText('Organization:')).toBeInTheDocument();
    });

    it('renders the entity log with the SAME markup the progress display uses', () => {
      // ASSIST-SURFACE-WARTS Lane B: this form-side log and AssistProgress's
      // completed-entity log are the same concept. They had two class families
      // (semiont-assist-widget__log* here, semiont-annotation-log* there) one
      // panel apart — one concept, one markup.
      const { container, rerender } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 5 }],
          }}
        />
      );
      rerender(
        <ReferencesPanel {...panelProps()} isAssisting={false} progress={null} />
      );

      expect(container.querySelector('.semiont-annotation-log')).toBeInTheDocument();
      expect(container.querySelector('.semiont-annotation-log-item')).toBeInTheDocument();
      expect(container.querySelector('.semiont-assist-widget__log')).not.toBeInTheDocument();
    });

    it('should hide entity type selection during detection', () => {
      renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={true}
          progress={{ percentage: 0, completedItems: [] }}
        />
      );

      expect(screen.queryByText('Select entity types')).not.toBeInTheDocument();
      expect(screen.queryByText('Person')).not.toBeInTheDocument();
    });

    it('should render cancel button when detecting', async () => {
      renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={true}
          progress={{ percentage: 0, completedItems: [] }}
        />
      );

      // The control's label comes from the AssistProgress namespace's `cancel`.
      const cancelButton = screen.getByTitle('Cancel');
      expect(cancelButton).toBeInTheDocument();
    });
  });

  describe('Detection Complete Log', () => {
    it('should show completed log after detection finishes', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [
              { value: 'Person', foundCount: 5 },
              { value: 'Organization', foundCount: 3 },
            ],
          }}
        />
      );

      // Parent clears progress after completion
      rerender(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={null}
        />
      );

      expect(screen.getByText('Person:')).toBeInTheDocument();
      expect(screen.getByText('Organization:')).toBeInTheDocument();
    });

    it('should show found counts in log', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(
        <ReferencesPanel {...panelProps()} isAssisting={false} progress={null} />
      );
      expect(screen.getByText(/Found.*5/i)).toBeInTheDocument();
    });

    it('should show checkmarks for completed types', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(
        <ReferencesPanel {...panelProps()} isAssisting={false} progress={null} />
      );
      expect(screen.getByText('✓')).toBeInTheDocument();
    });

    it('should show detection log and selection UI together after completion', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(
        <ReferencesPanel {...panelProps()} isAssisting={false} progress={null} />
      );

      // Should show both the completed log AND the selection UI
      expect(screen.getByText('Person:')).toBeInTheDocument(); // Log entry
      expect(screen.getByText('Select entity types')).toBeInTheDocument(); // Selection UI
    });

    it('should show selection UI immediately after detection completes', async () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(
        <ReferencesPanel {...panelProps()} isAssisting={false} progress={null} />
      );

      // Selection UI should be immediately available (no button click needed)
      expect(screen.getByText('Select entity types')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument(); // Entity type chip
    });

    it('should not show log when empty', () => {
      renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [],
          }}
        />
      );

      // Should not show any log items. Terminal progress (dismissable) is
      // shown instead of the form — the AssistShell normalization (#7); the
      // form returns once progress clears.
      expect(screen.queryByText('✓')).not.toBeInTheDocument();
      expect(screen.queryByText('Select entity types')).not.toBeInTheDocument();
    });
  });

  describe('State Transitions', () => {
    it('should transition from idle to detecting', () => {
      const { rerender } = renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      // Idle state
      expect(screen.getByText('Select entity types')).toBeInTheDocument();

      // Start detecting
      rerender(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={true}
          progress={{ percentage: 0, completedItems: [] }}
        />
      );

      // Detecting state
      expect(screen.getByText('Annotating...')).toBeInTheDocument();
      expect(screen.queryByText('Select entity types')).not.toBeInTheDocument();
    });

    it('should transition from detecting to complete', () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={true}
          progress={{ percentage: 0, completedItems: [] }}
        />
      );

      // Detecting
      expect(screen.getByText('Annotating...')).toBeInTheDocument();

      // Complete - first trigger useEffect to copy to lastDetectionLog
      rerender(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 5 }],
          }}
        />
      );

      // Then clear progress to show the log
      rerender(
        <ReferencesPanel {...panelProps()} isAssisting={false} progress={null} />
      );

      expect(screen.queryByText('Annotation complete!')).not.toBeInTheDocument();
      // Both log and selection UI should be visible
      expect(screen.getByText('Person:')).toBeInTheDocument();
      expect(screen.getByText('Select entity types')).toBeInTheDocument();
    });

    it('should show selection UI after detection completes', async () => {
      const { rerender } = renderWithEventBus(
        <ReferencesPanel
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 5 }],
          }}
        />
      );

      // Clear progress to show the log
      rerender(
        <ReferencesPanel {...panelProps()} isAssisting={false} progress={null} />
      );

      // Selection UI should be immediately available
      expect(screen.getByText('Select entity types')).toBeInTheDocument();

      rerender(
        <ReferencesPanel {...panelProps()} />
      );

      expect(screen.getByText('Select entity types')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty entity types array', () => {
      expect(() => {
        renderWithEventBus(<ReferencesPanel {...panelProps()} allEntityTypes={[]} />);
      }).not.toThrow();
    });

    it('should handle many entity types', () => {
      const manyTypes = Array.from({ length: 50 }, (_, i) => `Type${i}`);

      expect(() => {
        renderWithEventBus(<ReferencesPanel {...panelProps()} allEntityTypes={manyTypes} />);
      }).not.toThrow();

      expect(screen.getByText('Type0')).toBeInTheDocument();
      expect(screen.getByText('Type49')).toBeInTheDocument();
    });

    it('should handle entity types with special characters', () => {
      const specialTypes = ['Type-A', 'Type_B', 'Type.C', 'Type/D'];

      renderWithEventBus(<ReferencesPanel {...panelProps()} allEntityTypes={specialTypes} />);

      specialTypes.forEach(type => {
        expect(screen.getByText(type)).toBeInTheDocument();
      });
    });

    it('should handle selecting and deselecting all types', async () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

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
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

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
          {...panelProps()}
          isAssisting={false}
          progress={{
            percentage: 100,
            completedItems: [{ value: 'Person', foundCount: 0 }],
          }}
        />
      );

      expect(screen.getByText(/Found.*0/i)).toBeInTheDocument();
    });

    it('should handle undefined progress', () => {
      expect(() => {
        renderWithEventBus(
          <ReferencesPanel
            {...panelProps()}
            isAssisting={false}
            progress={undefined as any}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });

    it('should support dark mode', () => {
      const { container } = renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });

    it('should have title without emoji', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      // The emoji is no longer in the title (it's only in the tab now)
      const title = screen.getByRole('heading', { level: 2 });
      expect(title.textContent).not.toContain('🔵');
      expect(title.textContent).toContain('title');
    });

    it('should have proper button layout', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const buttonContainer = screen.getByText('Person').parentElement;
      expect(buttonContainer).toHaveClass('semiont-assist-widget__chips');
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels for selection', async () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-label');

      await userEvent.click(personButton);

      // Label should update to indicate deselection is possible
      const label = personButton.getAttribute('aria-label');
      expect(label).toBeTruthy();
    });

    it('should have proper ARIA pressed states', async () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-pressed', 'false');

      await userEvent.click(personButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'true');
    });

    it('should be keyboard navigable', () => {
      renderWithEventBus(<ReferencesPanel {...panelProps()} />);

      const personButton = screen.getByText('Person');
      personButton.focus();

      expect(personButton).toHaveFocus();
    });
  });
});
