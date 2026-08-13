import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AnnotationHistory } from '../AnnotationHistory';
import { renderWithProviders } from '../../../test-utils';

// Mock @semiont/core - must use importOriginal to preserve EventBus etc.
vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return {
    ...actual,
    getAnnotationUriFromEvent: vi.fn(() => null),
  };
});

// Mock TranslationContext
vi.mock('../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      history: 'History',
      loading: 'Loading...',
      failed: 'Could not load history.',
      retry: 'Try again',
    };
    return translations[key] || key;
  }),
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock HistoryEvent to avoid deep rendering and mocking all its dependencies
const MockHistoryEvent = vi.fn(({ event }: any) => (
  <div data-testid={`history-event-${event.id}`}>
    {event.type}
  </div>
));

vi.mock('../HistoryEvent', () => ({
  HistoryEvent: (props: any) => MockHistoryEvent(props),
}));

import { getAnnotationUriFromEvent } from '@semiont/core';
const mockGetAnnotationUri = getAnnotationUriFromEvent as ReturnType<typeof vi.fn>;

/** Returns flat StoredEventResponse shape (matches API response) */
function makeStoredEvent(id: string, type: string, seq: number, overrides: Record<string, any> = {}): any {
  return {
    id,
    type,
    timestamp: '2026-03-06T12:00:00Z',
    resourceId: 'res-1',
    userId: 'user-1',
    version: 1,
    payload: {},
    ...overrides,
    metadata: {
      sequenceNumber: seq,
    },
  };
}

const MockLink = ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>;
const mockRoutes = {
  resourceDetail: (id: string) => `/resources/${id}`,
} as any;

describe('AnnotationHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnnotationUri.mockReturnValue(null);
  });

  it('renders loading state', () => {
    renderWithProviders(
      <AnnotationHistory
        events={[]}
        eventsLoading
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  describe('terminal load failure', () => {
    // The panel used to derive `loading` from `eventsData === undefined` and
    // hard-code `const error = false`, so a failed load sat on "Loading..."
    // for ever and the error branch below it was unreachable.
    // See .plans/PANEL-FAILURE-STATES.md

    it('reports the failure instead of staying on the loading text', () => {
      renderWithProviders(
        <AnnotationHistory
          events={[]}
          eventsLoading={false}
          eventsError={new Error('Resource not found')}
          Link={MockLink}
          routes={mockRoutes}
        />
      );

      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      expect(screen.getByText('Could not load history.')).toBeInTheDocument();
    });

    it('offers a retry that calls back', async () => {
      const onRetryEvents = vi.fn();
      const { default: userEvent } = await import('@testing-library/user-event');

      renderWithProviders(
        <AnnotationHistory
          events={[]}
          eventsError={new Error('boom')}
          onRetryEvents={onRetryEvents}
          Link={MockLink}
          routes={mockRoutes}
        />
      );

      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetryEvents).toHaveBeenCalledTimes(1);
    });

    it('the failure beats the loading state — a dead request is not still loading', () => {
      renderWithProviders(
        <AnnotationHistory
          events={[]}
          eventsLoading
          eventsError={new Error('boom')}
          Link={MockLink}
          routes={mockRoutes}
        />
      );

      expect(screen.getByText('Could not load history.')).toBeInTheDocument();
    });
  });

  it('renders null when no events', () => {
    const { container } = renderWithProviders(
      <AnnotationHistory
        events={[]}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(container.innerHTML).toBe('');
  });

  it('renders events sorted by sequence number', () => {
    const events = [
      makeStoredEvent('e3', 'mark:added', 3),
      makeStoredEvent('e1', 'mark:added', 1),
      makeStoredEvent('e2', 'mark:added', 2),
    ];

    renderWithProviders(
      <AnnotationHistory
        events={events}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const renderedEvents = screen.getAllByTestId(/^history-event-/);
    expect(renderedEvents).toHaveLength(3);
    expect(renderedEvents[0]).toHaveAttribute('data-testid', 'history-event-e1');
    expect(renderedEvents[1]).toHaveAttribute('data-testid', 'history-event-e2');
    expect(renderedEvents[2]).toHaveAttribute('data-testid', 'history-event-e3');
  });

  it('filters out job events', () => {
    // e3 is `job:progress`, a retired event type. Logs written before it was
    // retired still hold them, so the filter must keep excluding it.
    const events = [
      makeStoredEvent('e1', 'mark:added', 1),
      makeStoredEvent('e2', 'job:started', 2),
      makeStoredEvent('e3', 'job:progress', 3),
      makeStoredEvent('e4', 'job:completed', 4),
      makeStoredEvent('e5', 'mark:body-updated', 5),
    ];

    renderWithProviders(
      <AnnotationHistory
        events={events}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const renderedEvents = screen.getAllByTestId(/^history-event-/);
    expect(renderedEvents).toHaveLength(2);
    expect(renderedEvents[0]).toHaveAttribute('data-testid', 'history-event-e1');
    expect(renderedEvents[1]).toHaveAttribute('data-testid', 'history-event-e5');
  });

  it('passes isRelated when hovered annotation matches event', () => {
    const events = [makeStoredEvent('e1', 'mark:added', 1)];
    mockGetAnnotationUri.mockReturnValue('ann-1');

    renderWithProviders(
      <AnnotationHistory
        events={events}
        hoveredAnnotationId="ann-1"
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(MockHistoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ isRelated: true })
    );
  });

  it('renders history panel structure with title and list', () => {
    const events = [makeStoredEvent('e1', 'mark:added', 1)];

    const { container } = renderWithProviders(
      <AnnotationHistory
        events={events}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(container.querySelector('.semiont-history-panel')).toBeInTheDocument();
    expect(container.querySelector('.semiont-history-panel__title')).toBeInTheDocument();
    expect(container.querySelector('.semiont-history-panel__list')).toBeInTheDocument();
  });
});
