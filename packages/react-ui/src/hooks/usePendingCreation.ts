'use client';

import { useState, useCallback } from 'react';
import type { EventMap, ResourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { useSessionEventSubscriptions } from './useSessionEventSubscriptions';

/**
 * A claimed `mark:requested` — the typed event payload (selector + motivation +
 * source), re-exported rather than a parallel shape.
 */
export type PendingCreation = EventMap['mark:requested'];

/**
 * The consuming half of the viewer's capture/policy split (HEADLESS-CREATION-SEAM).
 *
 * The viewer captures gestures and emits source-scoped `mark:requested`; this
 * hook claims them for ONE viewer: an event is claimed iff
 * `enabled && event.source === resourceId` — N mounted hooks on one session each
 * claim only their own (the multi-mount contract MARK-REQUESTED-RESOURCE-SCOPE
 * created). A new request for the same resource REPLACES an unresolved pending
 * (the user reselected; the stale pending is abandoned).
 *
 * Headless by contract: no creation call, no UI, no toast in here — resolution
 * (chooser flows, body forms, `mark.annotation`) is host policy. Session-first
 * like every subscribing primitive (`session.subscribe` is the sanctioned
 * generic-channel path); `null` → inert.
 *
 * @param session  Session whose bus carries this viewer's events; null → inert.
 * @param resourceId  Claim only events whose `source` is this resource.
 * @param enabled  The host's annotate-mode gate — browse-mode viewers never claim.
 */
export function usePendingCreation(
  session: SemiontSession | null,
  resourceId: ResourceId,
  enabled: boolean,
): { pending: PendingCreation | null; clearPending: () => void } {
  const [pending, setPending] = useState<PendingCreation | null>(null);

  useSessionEventSubscriptions(session, {
    'mark:requested': (event) => {
      if (!enabled) return;
      // Scope equality on the branded id's string form.
      if (String(event.source) !== String(resourceId)) return;
      setPending(event);
    },
  });

  const clearPending = useCallback(() => setPending(null), []);

  return { pending, clearPending };
}
