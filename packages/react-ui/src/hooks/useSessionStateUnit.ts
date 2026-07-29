'use client';

import { useEffect, useRef, useState } from 'react';
import type { StateUnit } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

/**
 * Construct a state unit whose lifetime is bound to a live `SemiontSession`
 * (.plans/SESSION-TYPED-FACTORIES.md — the session gate as API shape).
 *
 * Contract, in the order the KB-switch bug family demands it:
 * - one construction per live session, however often the component rerenders;
 * - on session swap, the OLD unit's `dispose()` runs strictly BEFORE the new
 *   factory — a unit must never coexist with its successor, or it keeps
 *   serving a disposed client's inert (B16) caches;
 * - no session → no construction, and the `T | undefined` return makes the
 *   caller handle it — the null-check lives at exactly this one layer, not
 *   inside `!`-asserted factories (the auth/welcome production crash);
 * - unmount disposes.
 *
 * Keying is by session OBJECT identity, which coincides with `session.id`:
 * successive sessions are distinct objects with distinct ids by construction
 * (`SemiontSession`'s instance counter exists for exactly this).
 *
 * The unit is created inside the effect, not during render — render stays
 * pure (StrictMode-safe: its probe mount cleanly disposes the probe unit),
 * and React's cleanup-before-next-effect ordering is what GUARANTEES
 * dispose-before-create on swap. Consequence: the unit is `undefined` on the
 * very first render frame; session-gated pages already render a loading
 * state for exactly that frame.
 *
 * The factory is read through a ref so the effect keys ONLY on the session —
 * an inline-closure factory (the universal call-site idiom) must not retrigger
 * construction on every render.
 */
export function useSessionStateUnit<T extends StateUnit>(
  session: SemiontSession | undefined,
  factory: (session: SemiontSession) => T,
): T | undefined {
  const [unit, setUnit] = useState<T | undefined>(undefined);
  const factoryRef = useRef(factory);
  factoryRef.current = factory;

  useEffect(() => {
    if (!session) {
      setUnit(undefined);
      return;
    }
    const created = factoryRef.current(session);
    setUnit(created);
    return () => {
      created.dispose();
      setUnit(undefined);
    };
  }, [session]);

  return unit;
}
