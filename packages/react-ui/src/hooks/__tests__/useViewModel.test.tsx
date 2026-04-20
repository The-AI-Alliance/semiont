/**
 * useViewModel tests
 *
 * Documents and locks in the factory-runs-once semantics of
 * `useViewModel`. The hook deliberately keeps a single VM instance for
 * the component's lifetime — call sites that depend on the factory
 * closing over a changing prop MUST force a remount (e.g. with
 * `key={someId}` on a wrapping component). Without that, the VM is
 * built with the initial value and never reflects later changes.
 *
 * A real bug hit this behaviour: `KnowledgeResourcePage` read `rId`
 * from route params and passed it into `useViewModel`'s factory.
 * Because React Router reuses the same component instance across
 * `:id` param changes, the VM stayed bound to the first resource id
 * and the page displayed stale content.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useViewModel } from '../useViewModel';

interface TestVM {
  id: string;
  dispose(): void;
}

function makeVM(id: string, disposeSpy?: ReturnType<typeof vi.fn>): TestVM {
  return {
    id,
    dispose: disposeSpy ?? vi.fn(),
  };
}

describe('useViewModel', () => {
  it('calls the factory exactly once on initial mount', () => {
    const factory = vi.fn(() => makeVM('vm-1'));
    renderHook(() => useViewModel(factory));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('returns the same VM instance across re-renders', () => {
    const factory = vi.fn(() => makeVM('vm-1'));
    const { result, rerender } = renderHook(() => useViewModel(factory));
    const first = result.current;

    rerender();
    rerender();

    expect(result.current).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-run the factory when a closed-over value changes — latent-bug guard', () => {
    // This is the bug signature of the resource-navigation issue: if a
    // caller writes `useViewModel(() => makeVM(props.rId))` and rId
    // changes, the VM is NOT recreated. The hook has no deps array.
    // Callers must use a key'd wrapper to force remount.
    let rId = 'res-A';
    const factory = vi.fn(() => makeVM(rId));
    const { result, rerender } = renderHook(() => useViewModel(factory));

    expect(result.current.id).toBe('res-A');

    rId = 'res-B';
    rerender();

    // Factory still not re-invoked; VM still bound to res-A.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.current.id).toBe('res-A');
  });

  it('disposes the VM on unmount', () => {
    const disposeSpy = vi.fn();
    const factory = vi.fn(() => makeVM('vm-1', disposeSpy));
    const { unmount } = renderHook(() => useViewModel(factory));

    expect(disposeSpy).not.toHaveBeenCalled();
    unmount();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('a key-bump on a wrapping component forces a fresh VM — the documented fix for param-dependent factories', () => {
    // Simulate what React does on a key change: unmount the old hook
    // and mount a new one. (`renderHook` doesn't offer a direct key API,
    // so we do it explicitly.)
    const disposeSpy = vi.fn();
    const factory = vi.fn((id: string) => makeVM(id, disposeSpy));

    const first = renderHook(
      ({ id }) => useViewModel(() => factory(id)),
      { initialProps: { id: 'res-A' } },
    );
    expect(first.result.current.id).toBe('res-A');
    expect(factory).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    const second = renderHook(
      ({ id }) => useViewModel(() => factory(id)),
      { initialProps: { id: 'res-B' } },
    );
    expect(second.result.current.id).toBe('res-B');
    expect(factory).toHaveBeenCalledTimes(2);

    // Rerender of the remounted hook does NOT call the factory again.
    second.rerender({ id: 'res-B' });
    expect(factory).toHaveBeenCalledTimes(2);

    second.unmount();
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });
});
