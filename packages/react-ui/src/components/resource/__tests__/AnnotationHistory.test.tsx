import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AnnotationHistory } from '../AnnotationHistory';
import { renderWithProviders } from '../../../test-utils';
import type { StoredEvent, ResourceUri } from '@semiont/core';

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

// Mock useResources from api-hooks
const mockEventsUseQuery = vi.fn();
const mockAnnotationsUseQuery = vi.fn();

vi.mock('../../../lib/api-hooks', () => ({
  useResources: () => ({
    events: { useQuery: mockEventsUseQuery },
    annotations: { useQuery: mockAnnotationsUseQuery },
  }),
}));

// Mock HistoryEvent to avoid deep rendering and mocking all its dependencies
const MockHistoryEvent = vi.fn(({ event }: any) => (
  <div data-testid={`history-event-${event.event.id}`}>
    {event.event.type}
  </div>
));

vi.mock('../HistoryEvent', () => ({
  HistoryEvent: (props: any) => MockHistoryEvent(props),
}));

import { getAnnotationUriFromEvent } from '@semiont/core';
const mockGetAnnotationUri = getAnnotationUriFromEvent as ReturnType<typeof vi.fn>;

const testRUri = 'http://localhost/resources/res-1' as ResourceUri;

function makeStoredEvent(id: string, type: string, seq: number, overrides: Record<string, any> = {}): StoredEvent {
  return {
    event: {
      id,
      type,
      timestamp: '2026-03-06T12:00:00Z',
      resourceId: 'http://localhost/resources/res-1',
      userId: 'user-1',
      version: 1,
      payload: {},
      ...overrides,
    },
    metadata: {
      sequenceNumber: seq,
      storedAt: '2026-03-06T12:00:00Z',
    },
  } as StoredEvent;
}

const MockLink = ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>;
const mockRoutes = {
  resourceDetail: (id: string) => `/resources/${id}`,
} as any;

describe('AnnotationHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnnotationUri.mockReturnValue(null);
    mockAnnotationsUseQuery.mockReturnValue({ data: { annotations: [] } });
  });

  it('renders loading state', () => {
    mockEventsUseQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders null on error', () => {
    mockEventsUseQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    const { container } = renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(container.innerHTML).toBe('');
  });

  it('renders null when no events', () => {
    mockEventsUseQuery.mockReturnValue({ data: { events: [] }, isLoading: false, isError: false });

    const { container } = renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(container.innerHTML).toBe('');
  });

  it('renders events sorted by sequence number', () => {
    const events = [
      makeStoredEvent('evt-3', 'annotation.added', 3),
      makeStoredEvent('evt-1', 'resource.created', 1),
      makeStoredEvent('evt-2', 'annotation.added', 2),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('History')).toBeInTheDocument();
    // All three events rendered
    expect(screen.getByTestId('history-event-evt-1')).toBeInTheDocument();
    expect(screen.getByTestId('history-event-evt-2')).toBeInTheDocument();
    expect(screen.getByTestId('history-event-evt-3')).toBeInTheDocument();

    // Verify HistoryEvent was called with events in sequence order
    const calls = MockHistoryEvent.mock.calls;
    expect(calls[0][0].event.event.id).toBe('evt-1');
    expect(calls[1][0].event.event.id).toBe('evt-2');
    expect(calls[2][0].event.event.id).toBe('evt-3');
  });

  it('filters out job events', () => {
    const events = [
      makeStoredEvent('evt-1', 'resource.created', 1),
      makeStoredEvent('evt-2', 'job.started', 2),
      makeStoredEvent('evt-3', 'job.progress', 3),
      makeStoredEvent('evt-4', 'job.completed', 4),
      makeStoredEvent('evt-5', 'annotation.added', 5),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    // Only non-job events should render
    expect(screen.getByTestId('history-event-evt-1')).toBeInTheDocument();
    expect(screen.getByTestId('history-event-evt-5')).toBeInTheDocument();
    expect(screen.queryByTestId('history-event-evt-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-event-evt-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-event-evt-4')).not.toBeInTheDocument();
  });

  it('passes isRelated=true when hoveredAnnotationId matches event', () => {
    const annotationUri = 'http://localhost/annotations/ann-1';
    mockGetAnnotationUri.mockReturnValue(annotationUri);

    const events = [
      makeStoredEvent('evt-1', 'annotation.added', 1),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        hoveredAnnotationId={annotationUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const call = MockHistoryEvent.mock.calls[0][0];
    expect(call.isRelated).toBe(true);
  });

  it('passes isRelated=false when hoveredAnnotationId does not match', () => {
    mockGetAnnotationUri.mockReturnValue('http://localhost/annotations/ann-other');

    const events = [
      makeStoredEvent('evt-1', 'annotation.added', 1),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        hoveredAnnotationId="http://localhost/annotations/ann-1"
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const call = MockHistoryEvent.mock.calls[0][0];
    expect(call.isRelated).toBe(false);
  });

  it('passes isRelated=false when no hoveredAnnotationId', () => {
    const events = [
      makeStoredEvent('evt-1', 'annotation.added', 1),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const call = MockHistoryEvent.mock.calls[0][0];
    expect(call.isRelated).toBe(false);
  });

  it('passes onEventClick and onEventHover to HistoryEvent', () => {
    const onEventClick = vi.fn();
    const onEventHover = vi.fn();

    const events = [
      makeStoredEvent('evt-1', 'resource.created', 1),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        onEventClick={onEventClick}
        onEventHover={onEventHover}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const call = MockHistoryEvent.mock.calls[0][0];
    expect(call.onEventClick).toBe(onEventClick);
    expect(call.onEventHover).toBe(onEventHover);
  });

  it('does not pass onEventClick/onEventHover when not provided', () => {
    const events = [
      makeStoredEvent('evt-1', 'resource.created', 1),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const call = MockHistoryEvent.mock.calls[0][0];
    expect(call.onEventClick).toBeUndefined();
    expect(call.onEventHover).toBeUndefined();
  });

  it('passes annotations from useQuery to HistoryEvent', () => {
    const mockAnnotations = [{ id: 'ann-1', body: [] }];
    mockAnnotationsUseQuery.mockReturnValue({ data: { annotations: mockAnnotations } });

    const events = [
      makeStoredEvent('evt-1', 'resource.created', 1),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const call = MockHistoryEvent.mock.calls[0][0];
    expect(call.annotations).toEqual(mockAnnotations);
  });

  it('defaults annotations to empty array when no data', () => {
    mockAnnotationsUseQuery.mockReturnValue({ data: undefined });

    const events = [
      makeStoredEvent('evt-1', 'resource.created', 1),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const call = MockHistoryEvent.mock.calls[0][0];
    expect(call.annotations).toEqual([]);
  });

  it('renders history panel structure with title and list', () => {
    const events = [
      makeStoredEvent('evt-1', 'resource.created', 1),
    ];
    mockEventsUseQuery.mockReturnValue({ data: { events }, isLoading: false, isError: false });

    const { container } = renderWithProviders(
      <AnnotationHistory
        rUri={testRUri}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(container.querySelector('.semiont-history-panel')).toBeInTheDocument();
    expect(container.querySelector('.semiont-history-panel__title')).toBeInTheDocument();
    expect(container.querySelector('.semiont-history-panel__list')).toBeInTheDocument();
  });
});
