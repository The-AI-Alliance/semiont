import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AnnotationHistory } from '../AnnotationHistory';
import { renderWithProviders } from '../../../test-utils';
import type { ResourceId } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

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
    };
    return translations[key] || key;
  }),
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const eventsSubject = new BehaviorSubject<any[] | undefined>(undefined);
const annotationsSubject = new BehaviorSubject<any[] | undefined>(undefined);

const stableMockClient = {
  browse: {
    events: () => eventsSubject.asObservable(),
    annotations: () => annotationsSubject.asObservable(),
  },
};
const stableMockSession = { client: stableMockClient };
const stableActiveSession$ = new BehaviorSubject<any>(stableMockSession);
const stableMockBrowser = { activeSession$: stableActiveSession$ };

vi.mock('../../../session/SemiontProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../session/SemiontProvider')>();
  return {
    ...actual,
    useSemiont: () => stableMockBrowser,
  };
});

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

const testRId = 'res-1' as ResourceId;

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
      streamPosition: 0,
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
    eventsSubject.next(undefined);
    annotationsSubject.next([]);
  });

  it('renders loading state', () => {
    eventsSubject.next(undefined);

    renderWithProviders(
      <AnnotationHistory
        rUri={testRId}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders null when no events', () => {
    eventsSubject.next([]);

    const { container } = renderWithProviders(
      <AnnotationHistory
        rUri={testRId}
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
    eventsSubject.next(events);

    renderWithProviders(
      <AnnotationHistory
        rUri={testRId}
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
    const events = [
      makeStoredEvent('e1', 'mark:added', 1),
      makeStoredEvent('e2', 'job:started', 2),
      makeStoredEvent('e3', 'job:progress', 3),
      makeStoredEvent('e4', 'job:completed', 4),
      makeStoredEvent('e5', 'mark:body-updated', 5),
    ];
    eventsSubject.next(events);

    renderWithProviders(
      <AnnotationHistory
        rUri={testRId}
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
    eventsSubject.next(events);
    mockGetAnnotationUri.mockReturnValue('ann-1');

    renderWithProviders(
      <AnnotationHistory
        rUri={testRId}
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
    eventsSubject.next(events);

    const { container } = renderWithProviders(
      <AnnotationHistory
        rUri={testRId}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(container.querySelector('.semiont-history-panel')).toBeInTheDocument();
    expect(container.querySelector('.semiont-history-panel__title')).toBeInTheDocument();
    expect(container.querySelector('.semiont-history-panel__list')).toBeInTheDocument();
  });
});
