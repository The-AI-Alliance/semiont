/**
 * BROWSER-KB-DISCOVERY P4 — the react-ui binding of the sdk's discovery
 * subscription. The hook is deliberately thin: it holds the last emitted
 * `DiscoveryState` (plus a `kbs` projection) and owns only lifecycle —
 * enabled (pause-when-closed), document visibility (pause-when-hidden,
 * resume polls the SAME transport so its ETag survives into a 304), and
 * unmount teardown. No merge policy: react-ui owns no KB registry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { DiscoveryReadResult, DiscoveryTransport } from '@semiont/sdk';
import { useKBDiscovery } from '../useKBDiscovery';

const KB = {
  host: 'localhost',
  port: 4001,
  placement: 'local' as const,
  managedBy: 'semiont-launcher',
  did: 'did:web:example',
  siteName: 'Example KB',
};

/** A scripted transport: returns queued results, then repeats the last one. */
function scriptedTransport(...results: DiscoveryReadResult[]): DiscoveryTransport & { reads: () => number } {
  let count = 0;
  return {
    read: async () => {
      const index = Math.min(count, results.length - 1);
      count += 1;
      return results[index]!;
    },
    reads: () => count,
  };
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  setDocumentHidden(false);
});

describe('useKBDiscovery', () => {
  it('materializes the managed state and kbs from the first poll', async () => {
    const transport = scriptedTransport({ kind: 'managed', kbs: [KB] });

    const { result, unmount } = renderHook(() => useKBDiscovery({ transport, intervalMs: 20 }));

    await waitFor(() => {
      expect(result.current.state?.kind).toBe('managed');
    });
    expect(result.current.kbs).toEqual([KB]);
    unmount();
  });

  it('surfaces the typed absent state with its reason', async () => {
    const transport = scriptedTransport({ kind: 'absent', reason: 'not-found' });

    const { result, unmount } = renderHook(() => useKBDiscovery({ transport, intervalMs: 20 }));

    await waitFor(() => {
      expect(result.current.state?.kind).toBe('absent');
    });
    expect(result.current.state).toMatchObject({ kind: 'absent', reason: 'not-found' });
    expect(result.current.kbs).toEqual([]);
    unmount();
  });

  it('updates when a later poll changes the document', async () => {
    const transport = scriptedTransport(
      { kind: 'managed', kbs: [] },
      { kind: 'managed', kbs: [KB] },
    );

    const { result, unmount } = renderHook(() => useKBDiscovery({ transport, intervalMs: 20 }));

    await waitFor(() => {
      expect(result.current.kbs).toEqual([KB]);
    });
    unmount();
  });

  it('is inert while enabled is false — the transport is never read', async () => {
    const transport = scriptedTransport({ kind: 'managed', kbs: [KB] });

    const { result, unmount } = renderHook(() => useKBDiscovery({ transport, enabled: false, intervalMs: 20 }));

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(transport.reads()).toBe(0);
    expect(result.current.state).toBeNull();
    expect(result.current.kbs).toEqual([]);
    unmount();
  });

  it('stops polling when enabled flips to false', async () => {
    const transport = scriptedTransport({ kind: 'managed', kbs: [KB] });

    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useKBDiscovery({ transport, enabled, intervalMs: 20 }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(result.current.state?.kind).toBe('managed');
    });

    rerender({ enabled: false });
    const readsAtDisable = transport.reads();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(transport.reads()).toBe(readsAtDisable);
    unmount();
  });

  it('pauses on document hidden and resumes (same transport) on visible', async () => {
    const transport = scriptedTransport({ kind: 'managed', kbs: [KB] });

    const { result, unmount } = renderHook(() => useKBDiscovery({ transport, intervalMs: 20 }));

    await waitFor(() => {
      expect(result.current.state?.kind).toBe('managed');
    });

    act(() => setDocumentHidden(true));
    const readsAtHide = transport.reads();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(transport.reads()).toBe(readsAtHide);

    act(() => setDocumentHidden(false));
    await waitFor(() => {
      expect(transport.reads()).toBeGreaterThan(readsAtHide);
    });
    // Still the same state, re-materialized through the same transport.
    expect(result.current.kbs).toEqual([KB]);
    unmount();
  });

  it('stops reading after unmount', async () => {
    const transport = scriptedTransport({ kind: 'managed', kbs: [KB] });

    const { result, unmount } = renderHook(() => useKBDiscovery({ transport, intervalMs: 20 }));

    await waitFor(() => {
      expect(result.current.state?.kind).toBe('managed');
    });

    unmount();
    const readsAtUnmount = transport.reads();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(transport.reads()).toBe(readsAtUnmount);
  });
});
