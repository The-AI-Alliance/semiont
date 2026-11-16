/**
 * useSessionStateUnit — the session gate as API shape
 * (.plans/SESSION-TYPED-FACTORIES.md, Phase 1).
 *
 * The unit's lifetime is keyed on SESSION identity: one construction per
 * live session, disposal strictly before the successor's factory runs (the
 * KB-switch ordering that froze pages when violated — a state unit holding
 * a disposed client's inert B16 caches), and NO construction without a
 * session — the null-check lives at exactly one layer, this hook, instead
 * of inside `!`-asserted factories (the auth/welcome production crash).
 *
 * Sessions here are REAL `SemiontSession`s over the scriptable transport
 * (`@semiont/sdk/testing` — no hand-rolled session mock; SDK-TESTING-DOUBLE
 * gap 5 exists for exactly this file's benefit).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { StateUnit } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { createTestSession } from '@semiont/sdk/testing';
import { useSessionStateUnit } from '../useSessionStateUnit';

interface TestUnit extends StateUnit {
  readonly ownerSessionId: string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSession(): SemiontSession {
  return createTestSession().session;
}

describe('useSessionStateUnit', () => {
  it('constructs exactly once for a stable session across rerenders', async () => {
    const session = makeSession();
    const factory = vi.fn(
      (s: SemiontSession): TestUnit => ({ ownerSessionId: s.id, dispose: vi.fn() }),
    );

    const { result, rerender } = renderHook(() => useSessionStateUnit(session, factory));

    await waitFor(() => expect(result.current).toBeDefined());
    rerender();
    rerender();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.current!.ownerSessionId).toBe(session.id);
  });

  it('session swap: the OLD unit is disposed BEFORE the new factory runs', async () => {
    const sessionA = makeSession();
    const sessionB = makeSession();
    expect(sessionA.id).not.toBe(sessionB.id);

    const order: string[] = [];
    const factory = (s: SemiontSession): TestUnit => {
      order.push(`create:${s.id}`);
      return { ownerSessionId: s.id, dispose: () => order.push(`dispose:${s.id}`) };
    };

    const { result, rerender } = renderHook(
      ({ session }: { session: SemiontSession }) => useSessionStateUnit(session, factory),
      { initialProps: { session: sessionA } },
    );
    await waitFor(() => expect(result.current?.ownerSessionId).toBe(sessionA.id));

    rerender({ session: sessionB });
    await waitFor(() => expect(result.current?.ownerSessionId).toBe(sessionB.id));

    // The KB-switch ordering: teardown, then successor. Never overlap.
    expect(order).toEqual([
      `create:${sessionA.id}`,
      `dispose:${sessionA.id}`,
      `create:${sessionB.id}`,
    ]);
  });

  it('unmount disposes the unit', async () => {
    const session = makeSession();
    const dispose = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSessionStateUnit(session, (s): TestUnit => ({ ownerSessionId: s.id, dispose })),
    );
    await waitFor(() => expect(result.current).toBeDefined());

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('no session → no construction, and the return type says so', async () => {
    const factory = vi.fn(
      (s: SemiontSession): TestUnit => ({ ownerSessionId: s.id, dispose: vi.fn() }),
    );

    const { result, rerender } = renderHook(
      ({ session }: { session: SemiontSession | undefined }) =>
        useSessionStateUnit(session, factory),
      { initialProps: { session: undefined as SemiontSession | undefined } },
    );

    rerender({ session: undefined });
    expect(factory).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();

    // Session arrives (activation completes) → the unit appears.
    const session = makeSession();
    rerender({ session });
    await waitFor(() => expect(result.current?.ownerSessionId).toBe(session.id));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('session removed (sign-out) → unit disposed and the hook returns undefined again', async () => {
    const session = makeSession();
    const dispose = vi.fn();
    const { result, rerender } = renderHook(
      ({ s }: { s: SemiontSession | undefined }) =>
        useSessionStateUnit(s, (live): TestUnit => ({ ownerSessionId: live.id, dispose })),
      { initialProps: { s: session as SemiontSession | undefined } },
    );
    await waitFor(() => expect(result.current).toBeDefined());

    rerender({ s: undefined });
    await waitFor(() => expect(result.current).toBeUndefined());
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
