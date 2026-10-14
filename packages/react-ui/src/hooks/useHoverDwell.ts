'use client';

import { useEffect, useState } from 'react';
import { createHoverDwell, type HoverDwell, type SemiontSession } from '@semiont/sdk';

/**
 * A hover dwell that tells `session` which annotation the pointer rests on.
 *
 * One is made for each session and delay, and disposed when either changes or
 * the component unmounts, so a rest in flight never outlives them. It is made
 * in an effect, so render stays pure: there is none on the first render, nor
 * while there is no session.
 *
 * @emits beckon:hover - The annotation when the pointer rests on it, and null when it leaves. Payload: { annotationId: string | null }
 */
export function useHoverDwell(session: SemiontSession | null | undefined, delayMs: number): HoverDwell | undefined {
  const [dwell, setDwell] = useState<HoverDwell | undefined>(undefined);

  useEffect(() => {
    if (!session) {
      setDwell(undefined);
      return;
    }
    const made = createHoverDwell((id) => session.client.beckon.hover(id), delayMs);
    setDwell(made);
    return () => {
      made.dispose();
      setDwell(undefined);
    };
  }, [session, delayMs]);

  return dwell;
}
