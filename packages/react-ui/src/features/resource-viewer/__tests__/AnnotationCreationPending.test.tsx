/**
 * Regression test: pendingAnnotation cleared after annotate:createsucceeds
 *
 * Bug: handleAnnotationCreate in useAnnotationFlow called the API and emitted
 * annotate:created, but never called setPendingAnnotation(null). The pending
 * creation form (e.g. "Create Reference", "Save" assessment) remained visible
 * after the user clicked the confirm button.
 *
 * Fix: setPendingAnnotation(null) added in handleAnnotationCreate on success,
 * before emitting annotate:created.
 *
 * This test covers all four motivations that have a pending form:
 * - linking  (ReferencesPanel: "Create Reference" button)
 * - assessing (AssessmentPanel: "Save" button)
 * - commenting (CommentsPanel: "Save" button)
 * - tagging   (TaggingPanel: category selection)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useAnnotationFlow } from '../../../hooks/useAnnotationFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';
import { resourceUri } from '@semiont/core';
import type { Emitter } from 'mitt';
import type { EventMap } from '@semiont/core';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));
import type { Motivation, Selector } from '@semiont/core';

const TEST_URI = resourceUri('http://localhost:4000/resources/test-resource');

const MOCK_ANNOTATION = {
  id: 'http://localhost:4000/annotations/new-1',
  type: 'Annotation',
  motivation: 'linking' as Motivation,
  target: { source: TEST_URI },
  body: [],
};

const TEXT_SELECTOR: Selector = {
  type: 'TextQuoteSelector',
  exact: 'some selected text',
};

const SVG_SELECTOR: Selector = {
  type: 'SvgSelector',
  value: '<rect x="10" y="20" width="100" height="50"/>',
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function renderDetectionFlow(testUri: string) {
  let eventBusInstance: Emitter<EventMap>;

  function EventBusCapture() {
    eventBusInstance = useEventBus();
    return null;
  }

  function DetectionFlowHarness() {
    const { pendingAnnotation } = useAnnotationFlow(testUri as any);
    return (
      <div>
        <div data-testid="pending-motivation">
          {pendingAnnotation ? pendingAnnotation.motivation : 'none'}
        </div>
      </div>
    );
  }

  render(
    <EventBusProvider>
      <AuthTokenProvider token={null}>
        <ApiClientProvider baseUrl="http://localhost:4000">
          <EventBusCapture />
          <DetectionFlowHarness />
        </ApiClientProvider>
      </AuthTokenProvider>
    </EventBusProvider>
  );

  return {
    getEventBus: () => eventBusInstance,
    emit: <K extends keyof EventMap>(event: K, payload: EventMap[K]) => {
      eventBusInstance.get(event).next(payload);
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Annotation creation clears pendingAnnotation', () => {
  let createAnnotationSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();
    createAnnotationSpy = vi
      .spyOn(SemiontApiClient.prototype, 'createAnnotation')
      .mockResolvedValue({ annotation: MOCK_ANNOTATION } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears pendingAnnotation after creating a reference (linking)', async () => {
    const { emit } = renderDetectionFlow(TEST_URI);

    // Set a pending annotation
    act(() => {
      emit('annotate:requested', { selector: TEXT_SELECTOR, motivation: 'linking' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('linking');
    });

    // Emit annotate:create(what ReferencesPanel does when user clicks "Create Reference")
    await act(async () => {
      emit('annotate:create', {
        motivation: 'linking',
        selector: TEXT_SELECTOR,
        body: [{ type: 'TextualBody', value: 'Person', purpose: 'tagging' }],
      });
    });

    // pendingAnnotation must be cleared
    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('none');
    });

    expect(createAnnotationSpy).toHaveBeenCalledTimes(1);
  });

  it('clears pendingAnnotation after creating an assessment (assessing)', async () => {
    const { emit } = renderDetectionFlow(TEST_URI);

    act(() => {
      emit('annotate:requested', { selector: SVG_SELECTOR, motivation: 'assessing' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('assessing');
    });

    await act(async () => {
      emit('annotate:create', {
        motivation: 'assessing',
        selector: SVG_SELECTOR,
        body: [{ type: 'TextualBody', value: 'Looks good', purpose: 'assessing' }],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('none');
    });
  });

  it('clears pendingAnnotation after creating an assessment with empty body (optional text)', async () => {
    const { emit } = renderDetectionFlow(TEST_URI);

    act(() => {
      emit('annotate:requested', { selector: SVG_SELECTOR, motivation: 'assessing' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('assessing');
    });

    // Empty body is valid for assessments
    await act(async () => {
      emit('annotate:create', {
        motivation: 'assessing',
        selector: SVG_SELECTOR,
        body: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('none');
    });
  });

  it('clears pendingAnnotation after creating a comment (commenting)', async () => {
    const { emit } = renderDetectionFlow(TEST_URI);

    act(() => {
      emit('annotate:requested', { selector: TEXT_SELECTOR, motivation: 'commenting' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('commenting');
    });

    await act(async () => {
      emit('annotate:create', {
        motivation: 'commenting',
        selector: TEXT_SELECTOR,
        body: [{ type: 'TextualBody', value: 'Great point', purpose: 'commenting' }],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('none');
    });
  });

  it('clears pendingAnnotation after creating a tag (tagging)', async () => {
    const { emit } = renderDetectionFlow(TEST_URI);

    act(() => {
      emit('annotate:requested', { selector: SVG_SELECTOR, motivation: 'tagging' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('tagging');
    });

    await act(async () => {
      emit('annotate:create', {
        motivation: 'tagging',
        selector: SVG_SELECTOR,
        body: [{ type: 'TextualBody', value: 'concept:trust', purpose: 'tagging' }],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('none');
    });
  });

  it('emits annotate:created after successful creation', async () => {
    const { emit, getEventBus } = renderDetectionFlow(TEST_URI);

    const createdListener = vi.fn();
    // Set listener after first render so eventBus is captured
    await waitFor(() => expect(getEventBus()).toBeDefined());
    const subscription = getEventBus().get('annotate:created').subscribe(createdListener);

    act(() => {
      emit('annotate:requested', { selector: TEXT_SELECTOR, motivation: 'linking' });
    });

    await act(async () => {
      emit('annotate:create', {
        motivation: 'linking',
        selector: TEXT_SELECTOR,
        body: [],
      });
    });

    await waitFor(() => {
      expect(createdListener).toHaveBeenCalledTimes(1);
      expect(createdListener).toHaveBeenCalledWith({ annotation: MOCK_ANNOTATION });
    });

    subscription.unsubscribe();
  });

  it('does NOT clear pendingAnnotation if API call fails', async () => {
    createAnnotationSpy.mockRejectedValueOnce(new Error('Network error'));

    const { emit } = renderDetectionFlow(TEST_URI);

    act(() => {
      emit('annotate:requested', { selector: TEXT_SELECTOR, motivation: 'linking' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('linking');
    });

    await act(async () => {
      emit('annotate:create', {
        motivation: 'linking',
        selector: TEXT_SELECTOR,
        body: [],
      });
    });

    // Give async rejection time to settle
    await waitFor(() => {
      // pending should remain — user can retry or cancel
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('linking');
    });
  });

  it('clears pendingAnnotation on cancel (annotate:cancel-pending)', async () => {
    const { emit } = renderDetectionFlow(TEST_URI);

    act(() => {
      emit('annotate:requested', { selector: TEXT_SELECTOR, motivation: 'assessing' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('assessing');
    });

    act(() => {
      emit('annotate:cancel-pending', undefined);
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-motivation')).toHaveTextContent('none');
    });

    // API should NOT have been called on cancel
    expect(createAnnotationSpy).not.toHaveBeenCalled();
  });
});
