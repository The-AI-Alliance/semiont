/**
 * useMarkFlow tests
 *
 * Tests pending annotation state, AI-assist state, and EventBus-driven transitions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useMarkFlow } from '../useMarkFlow';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';
import { resourceId as makeResourceId } from '@semiont/core';

vi.mock('@semiont/api-client', () => ({
  SemiontApiClient: vi.fn(function () {}),
  baseUrl: vi.fn(function (url: string) { return url; }),
  accessToken: vi.fn(function (t: string) { return t as any; }),
}));

vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

const mockFlowMark = vi.fn().mockReturnValue({ unsubscribe: vi.fn() });
const mockClient = {
  stores: { resources: { setTokenGetter: vi.fn() }, annotations: { setTokenGetter: vi.fn() } },
  flows: { mark: mockFlowMark },
};

vi.mocked(SemiontApiClient).mockImplementation(function () { return mockClient; });

const RID = makeResourceId('res-1');

const wrapper = ({ children }: { children: ReactNode }) =>
  React.createElement(
    EventBusProvider,
    null,
    React.createElement(
      AuthTokenProvider,
      { token: null },
      React.createElement(ApiClientProvider, { baseUrl: 'http://localhost:4000' }, children)
    )
  );

function renderMarkFlow() {
  return renderHook(
    () => ({ flow: useMarkFlow(RID), bus: useEventBus() }),
    { wrapper }
  );
}

describe('useMarkFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlowMark.mockReturnValue({ unsubscribe: vi.fn() });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with null pending annotation and null assist state', () => {
    const { result } = renderMarkFlow();
    expect(result.current.flow.pendingAnnotation).toBeNull();
    expect(result.current.flow.assistingMotivation).toBeNull();
    expect(result.current.flow.progress).toBeNull();
  });

  it('activates the mark flow engine on mount', () => {
    renderMarkFlow();
    expect(mockFlowMark).toHaveBeenCalledWith(RID, expect.any(Function));
  });

  it('sets pendingAnnotation on mark:requested', async () => {
    const { result } = renderMarkFlow();

    act(() => {
      result.current.bus.get('mark:requested').next({
        selector: { type: 'TextQuoteSelector', exact: 'hello' },
        motivation: 'commenting',
      });
    });

    await waitFor(() => {
      expect(result.current.flow.pendingAnnotation).toMatchObject({ motivation: 'commenting' });
    });
  });

  it('clears pendingAnnotation on mark:cancel-pending', async () => {
    const { result } = renderMarkFlow();

    act(() => {
      result.current.bus.get('mark:requested').next({
        selector: { type: 'TextQuoteSelector', exact: 'hello' },
        motivation: 'commenting',
      });
    });
    await waitFor(() => expect(result.current.flow.pendingAnnotation).not.toBeNull());

    act(() => {
      result.current.bus.get('mark:cancel-pending').next(undefined as any);
    });
    await waitFor(() => expect(result.current.flow.pendingAnnotation).toBeNull());
  });

  it('clears pendingAnnotation on mark:created', async () => {
    const { result } = renderMarkFlow();

    act(() => {
      result.current.bus.get('mark:requested').next({
        selector: { type: 'TextQuoteSelector', exact: 'hello' },
        motivation: 'commenting',
      });
    });
    await waitFor(() => expect(result.current.flow.pendingAnnotation).not.toBeNull());

    act(() => {
      result.current.bus.get('mark:create-ok').next({ annotationId: 'ann-1' } as any);
    });
    await waitFor(() => expect(result.current.flow.pendingAnnotation).toBeNull());
  });

  it('sets assistingMotivation on mark:assist-request', async () => {
    const { result } = renderMarkFlow();

    act(() => {
      result.current.bus.get('mark:assist-request').next({ motivation: 'highlighting' } as any);
    });

    await waitFor(() => {
      expect(result.current.flow.assistingMotivation).toBe('highlighting');
    });
  });

  it('updates progress on mark:progress', async () => {
    const { result } = renderMarkFlow();
    const mockProgress = { status: 'running' as const, currentEntityType: 'Animal', foundCount: 3, percentage: 50 };

    act(() => {
      result.current.bus.get('mark:progress').next(mockProgress);
    });

    await waitFor(() => {
      expect(result.current.flow.progress).toEqual(mockProgress);
    });
  });

  it('clears assistingMotivation on mark:assist-finished', async () => {
    const { result } = renderMarkFlow();

    act(() => {
      result.current.bus.get('mark:assist-request').next({ motivation: 'commenting' } as any);
    });
    await waitFor(() => expect(result.current.flow.assistingMotivation).toBe('commenting'));

    act(() => {
      result.current.bus.get('mark:assist-finished').next({ motivation: 'commenting' } as any);
    });
    await waitFor(() => expect(result.current.flow.assistingMotivation).toBeNull());
  });

  it('clears assist state on mark:assist-failed', async () => {
    const { result } = renderMarkFlow();

    act(() => {
      result.current.bus.get('mark:assist-request').next({ motivation: 'tagging' } as any);
    });
    await waitFor(() => expect(result.current.flow.assistingMotivation).toBe('tagging'));

    act(() => {
      result.current.bus.get('mark:assist-failed').next({ payload: { error: 'fail' } } as any);
    });
    await waitFor(() => {
      expect(result.current.flow.assistingMotivation).toBeNull();
      expect(result.current.flow.progress).toBeNull();
    });
  });

  it('clears progress on mark:progress-dismiss', async () => {
    const { result } = renderMarkFlow();
    const mockProgress = { status: 'running' as const, currentEntityType: 'Animal', foundCount: 1, percentage: 30 };

    act(() => {
      result.current.bus.get('mark:progress').next(mockProgress);
    });
    await waitFor(() => expect(result.current.flow.progress).not.toBeNull());

    act(() => {
      result.current.bus.get('mark:progress-dismiss').next(undefined as any);
    });
    await waitFor(() => expect(result.current.flow.progress).toBeNull());
  });

  describe('mark:select-* events', () => {
    const selection = { exact: 'selected text', prefix: 'some ', suffix: ' here' };

    it('sets pendingAnnotation with commenting motivation on mark:select-comment', async () => {
      const { result } = renderMarkFlow();
      act(() => { result.current.bus.get('mark:select-comment').next(selection as any); });
      await waitFor(() => expect(result.current.flow.pendingAnnotation?.motivation).toBe('commenting'));
    });

    it('sets pendingAnnotation with tagging motivation on mark:select-tag', async () => {
      const { result } = renderMarkFlow();
      act(() => { result.current.bus.get('mark:select-tag').next(selection as any); });
      await waitFor(() => expect(result.current.flow.pendingAnnotation?.motivation).toBe('tagging'));
    });

    it('sets pendingAnnotation with assessing motivation on mark:select-assessment', async () => {
      const { result } = renderMarkFlow();
      act(() => { result.current.bus.get('mark:select-assessment').next(selection as any); });
      await waitFor(() => expect(result.current.flow.pendingAnnotation?.motivation).toBe('assessing'));
    });

    it('sets pendingAnnotation with linking motivation on mark:select-reference', async () => {
      const { result } = renderMarkFlow();
      act(() => { result.current.bus.get('mark:select-reference').next(selection as any); });
      await waitFor(() => expect(result.current.flow.pendingAnnotation?.motivation).toBe('linking'));
    });
  });

  it('returns a non-null assistStreamRef', () => {
    const { result } = renderMarkFlow();
    expect(result.current.flow.assistStreamRef).toBeDefined();
    expect(result.current.flow.assistStreamRef.current).toBeNull();
  });
});
