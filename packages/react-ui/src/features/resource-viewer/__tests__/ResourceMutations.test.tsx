/**
 * Regression test: resource mutations must be hoisted to component top level
 *
 * Bug: handleResourceClone (and handleResourceArchive / handleResourceUnarchive)
 * called useMutation() inside a useCallback, violating the Rules of Hooks.
 * React does not re-execute memoized callbacks on every render, so the mutation
 * object was never properly initialised and .mutateAsync() threw immediately,
 * always landing in the catch block and showing "Failed to generate clone link".
 *
 * Fix: the two mutations (updateMutation, generateCloneTokenMutation) are now
 * called unconditionally at the top level of ResourceViewerPage, and the
 * resulting objects are threaded into the useCallback dependency arrays.
 *
 * This test suite uses a minimal harness that:
 * - Mounts the REAL useResources() hook (which calls useMutation internally)
 * - Wires up a REAL EventBus and subscribes the same handlers as ResourceViewerPage
 * - Spies on SemiontApiClient.prototype to intercept API calls
 *
 * It confirms that each event-driven mutation calls the API exactly once,
 * and that the clipboard is written with the correct token URL for clone.
 */

import React, { useCallback } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SemiontApiClient, resourceUri, accessToken } from '@semiont/api-client';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { useResources } from '../../../lib/api-hooks';
import type { EventMap, EventBus } from '@semiont/core';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_URI = resourceUri('http://localhost:4000/resources/test-resource');
const TEST_TOKEN = 'test-auth-token-123';
const BASE_URL = 'http://localhost:4000';
const CLONE_TOKEN = 'generated-clone-token-xyz';

// ─── Harness ──────────────────────────────────────────────────────────────────

/**
 * Minimal harness that replicates the three mutation-backed event handlers
 * from ResourceViewerPage using the REAL useResources hook.
 *
 * The critical invariant under test: useMutation() is called at hook level
 * (inside useResources), not inside the useCallback bodies.
 */
function ResourceMutationHarness({ onEventBus }: { onEventBus: (eventBus: EventBus) => void }) {
  const eventBus = useEventBus();

  // Capture the eventBus for the test to emit events
  React.useEffect(() => {
    onEventBus(eventBus);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Real hook — mutations are initialised at the top level of useResources()
  const resources = useResources();

  // Mutations hoisted to this component's top level — same pattern as ResourceViewerPage fix
  const updateMutation = resources.update.useMutation();
  const generateCloneTokenMutation = resources.generateCloneToken.useMutation();

  const handleResourceArchive = useCallback(async () => {
    await updateMutation.mutateAsync({ rUri: TEST_URI, data: { archived: true } });
  }, [updateMutation]);

  const handleResourceUnarchive = useCallback(async () => {
    await updateMutation.mutateAsync({ rUri: TEST_URI, data: { archived: false } });
  }, [updateMutation]);

  const handleResourceClone = useCallback(async () => {
    const result = await generateCloneTokenMutation.mutateAsync(TEST_URI);
    const cloneUrl = `${window.location.origin}/know/clone?token=${result.token}`;
    await navigator.clipboard.writeText(cloneUrl);
  }, [generateCloneTokenMutation]);

  useEventSubscriptions({
    'resource:archive': handleResourceArchive,
    'resource:unarchive': handleResourceUnarchive,
    'resource:clone': handleResourceClone,
  });

  return null;
}

// ─── Test setup ───────────────────────────────────────────────────────────────

function renderHarness() {
  let capturedEventBus: EventBus | null = null;

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <AuthTokenProvider token={TEST_TOKEN}>
      <ApiClientProvider baseUrl={BASE_URL}>
        <QueryClientProvider client={queryClient}>
          <EventBusProvider>
            <ResourceMutationHarness onEventBus={(eventBus) => { capturedEventBus = eventBus; }} />
          </EventBusProvider>
        </QueryClientProvider>
      </ApiClientProvider>
    </AuthTokenProvider>
  );

  const emit = <K extends keyof EventMap>(event: K, payload: EventMap[K]) => {
    act(() => { capturedEventBus!.get(event).next(payload); });
  };

  return { emit };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Resource mutations — hooks hoisted to top level', () => {
  let generateCloneTokenSpy: ReturnType<typeof vi.spyOn>;
  let updateResourceSpy: ReturnType<typeof vi.spyOn>;
  let writeTextSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();

    generateCloneTokenSpy = vi
      .spyOn(SemiontApiClient.prototype, 'generateCloneToken')
      .mockResolvedValue({ token: CLONE_TOKEN } as any);

    updateResourceSpy = vi
      .spyOn(SemiontApiClient.prototype, 'updateResource')
      .mockResolvedValue({ resource: {} } as any);

    // jsdom has no clipboard — install a writable spy
    writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Clone ──────────────────────────────────────────────────────────────────

  it('calls generateCloneToken API when resource:clone event fires', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:clone', undefined);
    });

    await waitFor(() => {
      expect(generateCloneTokenSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('passes the resource URI to generateCloneToken', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:clone', undefined);
    });

    await waitFor(() => {
      expect(generateCloneTokenSpy).toHaveBeenCalledWith(
        TEST_URI,
        expect.anything()
      );
    });
  });

  it('passes auth token to generateCloneToken', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:clone', undefined);
    });

    await waitFor(() => {
      expect(generateCloneTokenSpy).toHaveBeenCalledWith(
        TEST_URI,
        expect.objectContaining({ auth: accessToken(TEST_TOKEN) })
      );
    });
  });

  it('writes a clone URL containing the returned token to the clipboard', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:clone', undefined);
    });

    await waitFor(() => {
      expect(writeTextSpy).toHaveBeenCalledTimes(1);
    });

    const writtenUrl: string = writeTextSpy.mock.calls[0][0];
    expect(writtenUrl).toContain(CLONE_TOKEN);
    expect(writtenUrl).toContain('/know/clone?token=');
  });

  it('does NOT call updateResource when resource:clone fires', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:clone', undefined);
    });

    await waitFor(() => {
      expect(generateCloneTokenSpy).toHaveBeenCalledTimes(1);
    });

    expect(updateResourceSpy).not.toHaveBeenCalled();
  });

  // ── Archive ────────────────────────────────────────────────────────────────

  it('calls updateResource with archived:true when resource:archive fires', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:archive', undefined);
    });

    await waitFor(() => {
      expect(updateResourceSpy).toHaveBeenCalledTimes(1);
    });

    expect(updateResourceSpy).toHaveBeenCalledWith(
      TEST_URI,
      expect.objectContaining({ archived: true }),
      expect.anything()
    );
  });

  it('does NOT call generateCloneToken when resource:archive fires', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:archive', undefined);
    });

    await waitFor(() => {
      expect(updateResourceSpy).toHaveBeenCalledTimes(1);
    });

    expect(generateCloneTokenSpy).not.toHaveBeenCalled();
  });

  // ── Unarchive ──────────────────────────────────────────────────────────────

  it('calls updateResource with archived:false when resource:unarchive fires', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:unarchive', undefined);
    });

    await waitFor(() => {
      expect(updateResourceSpy).toHaveBeenCalledTimes(1);
    });

    expect(updateResourceSpy).toHaveBeenCalledWith(
      TEST_URI,
      expect.objectContaining({ archived: false }),
      expect.anything()
    );
  });

  // ── Isolation ─────────────────────────────────────────────────────────────

  it('resource:archive and resource:clone events each call their own API exactly once', async () => {
    const { emit } = renderHarness();

    await act(async () => {
      emit('resource:archive', undefined);
    });

    await act(async () => {
      emit('resource:clone', undefined);
    });

    await waitFor(() => {
      expect(updateResourceSpy).toHaveBeenCalledTimes(1);
      expect(generateCloneTokenSpy).toHaveBeenCalledTimes(1);
    });
  });
});
