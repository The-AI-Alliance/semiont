import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { HistoryEvent } from '../HistoryEvent';
import { renderWithProviders } from '../../../test-utils';
import type { StoredEvent } from '@semiont/core';

// Mock @semiont/core - must use importOriginal to preserve EventBus etc.
vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return {
    ...actual,
    getAnnotationUriFromEvent: vi.fn(() => null),
  };
});

// Stable mock return values (defined outside vi.mock to avoid re-render loops)
const mockDisplayContent = { exact: 'Test content', isTag: false, isQuoted: false };
const mockEmptyDisplayContent = null;
const mockTagContent = { exact: 'Person', isTag: true, isQuoted: false };
const mockQuotedContent = { exact: 'quoted text', isTag: false, isQuoted: true };
const mockEntityTypes: string[] = [];
const mockCreationDetails = null;

// Mock event-formatting utilities
vi.mock('../event-formatting', () => ({
  formatEventType: vi.fn((_type: string, t: (key: string) => string) => t('resourceCreated')),
  getEventEmoji: vi.fn(() => '\u{1F4C4}'),
  formatRelativeTime: vi.fn(() => '2 minutes ago'),
  getEventDisplayContent: vi.fn(() => mockDisplayContent),
  getEventEntityTypes: vi.fn(() => mockEntityTypes),
  getResourceCreationDetails: vi.fn(() => mockCreationDetails),
}));

import { getAnnotationUriFromEvent } from '@semiont/core';
import {
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
  getEventDisplayContent,
  getEventEntityTypes,
  getResourceCreationDetails,
} from '../event-formatting';

const mockGetAnnotationUri = getAnnotationUriFromEvent as ReturnType<typeof vi.fn>;
const mockGetEventDisplayContent = getEventDisplayContent as ReturnType<typeof vi.fn>;
const mockGetEventEntityTypes = getEventEntityTypes as ReturnType<typeof vi.fn>;
const mockGetResourceCreationDetails = getResourceCreationDetails as ReturnType<typeof vi.fn>;
const mockFormatEventType = formatEventType as ReturnType<typeof vi.fn>;

function makeStoredEvent(overrides: Partial<StoredEvent['event']> = {}): StoredEvent {
  return {
    event: {
      id: 'evt-1',
      type: 'resource.created',
      timestamp: '2026-03-06T12:00:00Z',
      resourceId: 'http://localhost/resources/res-1',
      userId: 'user-1',
      version: 1,
      payload: { name: 'Test', format: 'text/plain', contentChecksum: 'abc', creationMethod: 'upload' },
      ...overrides,
    },
    metadata: {
      sequenceNumber: 1,
      storedAt: '2026-03-06T12:00:00Z',
    },
  } as StoredEvent;
}

const mockT = (key: string) => key;
const MockLink = ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>;
const mockRoutes = {
  resourceDetail: (id: string) => `/resources/${id}`,
} as any;

describe('HistoryEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnnotationUri.mockReturnValue(null);
    mockGetEventDisplayContent.mockReturnValue(mockDisplayContent);
    mockGetEventEntityTypes.mockReturnValue(mockEntityTypes);
    mockGetResourceCreationDetails.mockReturnValue(mockCreationDetails);
  });

  it('renders basic event with display content', () => {
    const event = makeStoredEvent();
    renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('Test content')).toBeInTheDocument();
    expect(screen.getByText('2 minutes ago')).toBeInTheDocument();
  });

  it('renders emoji from getEventEmoji', () => {
    const event = makeStoredEvent();
    renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('\u{1F4C4}')).toBeInTheDocument();
  });

  it('renders as div when no annotationUri', () => {
    mockGetAnnotationUri.mockReturnValue(null);
    const event = makeStoredEvent();
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const wrapper = container.querySelector('.semiont-history-event');
    expect(wrapper?.tagName).toBe('DIV');
  });

  it('renders as button when annotationUri exists', () => {
    mockGetAnnotationUri.mockReturnValue('http://localhost/annotations/ann-1');
    const event = makeStoredEvent({ type: 'annotation.added' } as any);
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const wrapper = container.querySelector('.semiont-history-event');
    expect(wrapper?.tagName).toBe('BUTTON');
  });

  it('calls onEventClick when button is clicked', () => {
    const annotationUri = 'http://localhost/annotations/ann-1';
    mockGetAnnotationUri.mockReturnValue(annotationUri);
    const onEventClick = vi.fn();
    const event = makeStoredEvent({ type: 'annotation.added' } as any);

    renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
        onEventClick={onEventClick}
      />
    );

    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(onEventClick).toHaveBeenCalledWith(annotationUri);
  });

  it('sets data-related attribute based on isRelated prop', () => {
    const event = makeStoredEvent();
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={true}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const wrapper = container.querySelector('.semiont-history-event');
    expect(wrapper).toHaveAttribute('data-related', 'true');
  });

  it('sets data-related=false when not related', () => {
    const event = makeStoredEvent();
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const wrapper = container.querySelector('.semiont-history-event');
    expect(wrapper).toHaveAttribute('data-related', 'false');
  });

  it('renders userId when present', () => {
    const event = makeStoredEvent({ userId: 'alice' } as any);
    renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('renders tag content with tag class', () => {
    mockGetEventDisplayContent.mockReturnValue(mockTagContent);
    const event = makeStoredEvent();
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const tagEl = container.querySelector('.semiont-history-event__tag');
    expect(tagEl).toBeInTheDocument();
    expect(tagEl).toHaveTextContent('Person');
  });

  it('renders quoted content with quoted class', () => {
    mockGetEventDisplayContent.mockReturnValue(mockQuotedContent);
    const event = makeStoredEvent();
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const quotedEl = container.querySelector('.semiont-history-event__text--quoted');
    expect(quotedEl).toBeInTheDocument();
  });

  it('falls back to formatEventType when displayContent is null', () => {
    mockGetEventDisplayContent.mockReturnValue(mockEmptyDisplayContent);
    mockFormatEventType.mockReturnValue('Resource Created');
    const event = makeStoredEvent();
    renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('Resource Created')).toBeInTheDocument();
  });

  it('renders entity type tags when present', () => {
    mockGetEventEntityTypes.mockReturnValue(['Person', 'Organization']);
    const event = makeStoredEvent();
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('Person')).toBeInTheDocument();
    expect(screen.getByText('Organization')).toBeInTheDocument();
    const tags = container.querySelectorAll('.semiont-tag--small');
    expect(tags).toHaveLength(2);
  });

  it('renders creation details when present', () => {
    mockGetResourceCreationDetails.mockReturnValue({
      type: 'created',
      userId: 'alice',
      method: 'upload',
    });
    const event = makeStoredEvent();
    renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('upload')).toBeInTheDocument();
  });

  it('renders "View Original" link for cloned resources', () => {
    mockGetResourceCreationDetails.mockReturnValue({
      type: 'cloned',
      userId: 'bob',
      method: 'clone',
      sourceDocId: 'doc-source-123',
    });
    const event = makeStoredEvent();
    renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const link = screen.getByText('viewOriginal');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/resources/doc-source-123');
  });

  it('calls onEventRef with annotationUri and element', () => {
    const annotationUri = 'http://localhost/annotations/ann-1';
    mockGetAnnotationUri.mockReturnValue(annotationUri);
    const onEventRef = vi.fn();
    const event = makeStoredEvent({ type: 'annotation.added' } as any);

    renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
        onEventRef={onEventRef}
      />
    );

    expect(onEventRef).toHaveBeenCalledWith(annotationUri, expect.any(HTMLElement));
  });

  it('handles emoji hover with delayed callback', () => {
    vi.useFakeTimers();
    const annotationUri = 'http://localhost/annotations/ann-1';
    mockGetAnnotationUri.mockReturnValue(annotationUri);
    const onEventHover = vi.fn();
    const event = makeStoredEvent({ type: 'annotation.added' } as any);

    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
        onEventHover={onEventHover}
      />
    );

    const emoji = container.querySelector('.semiont-history-event__emoji')!;
    fireEvent.mouseEnter(emoji);

    // Should not fire immediately
    expect(onEventHover).not.toHaveBeenCalled();

    // Should fire after 300ms delay
    act(() => { vi.advanceTimersByTime(300); });
    expect(onEventHover).toHaveBeenCalledWith(annotationUri);

    vi.useRealTimers();
  });

  it('clears hover on mouse leave and calls with null', () => {
    vi.useFakeTimers();
    const annotationUri = 'http://localhost/annotations/ann-1';
    mockGetAnnotationUri.mockReturnValue(annotationUri);
    const onEventHover = vi.fn();
    const event = makeStoredEvent({ type: 'annotation.added' } as any);

    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
        onEventHover={onEventHover}
      />
    );

    const emoji = container.querySelector('.semiont-history-event__emoji')!;
    fireEvent.mouseEnter(emoji);

    // Leave before 300ms timeout fires
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.mouseLeave(emoji);

    // The timeout should have been cleared, and hover state cleared
    expect(onEventHover).toHaveBeenCalledWith(null);

    // After full timeout, the delayed hover should NOT have fired
    act(() => { vi.advanceTimersByTime(300); });
    expect(onEventHover).toHaveBeenCalledTimes(1); // Only the null call

    vi.useRealTimers();
  });

  it('sets data-interactive on button wrapper', () => {
    mockGetAnnotationUri.mockReturnValue('http://localhost/annotations/ann-1');
    const event = makeStoredEvent({ type: 'annotation.added' } as any);
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const wrapper = container.querySelector('.semiont-history-event');
    expect(wrapper).toHaveAttribute('data-interactive', 'true');
  });

  it('does not set data-interactive on div wrapper', () => {
    mockGetAnnotationUri.mockReturnValue(null);
    const event = makeStoredEvent();
    const { container } = renderWithProviders(
      <HistoryEvent
        event={event}
        annotations={[]}
        allEvents={[event]}
        isRelated={false}
        t={mockT}
        Link={MockLink}
        routes={mockRoutes}
      />
    );

    const wrapper = container.querySelector('.semiont-history-event');
    expect(wrapper).not.toHaveAttribute('data-interactive');
  });
});
