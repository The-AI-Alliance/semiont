'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnchoredText } from '@semiont/core';
import { resourceId as toResourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

/**
 * The three-way absence a served anchored map can report, plus `null` for
 * "nobody has asked yet". `not-yet` is the only RETRYABLE one: the smelter
 * has not produced the map, but it intends to. `declined`, `no-map` and
 * `unknown` are terminal answers — asking again cannot change them.
 */
export type AnchoredKind = 'extracted' | 'declined' | 'not-yet' | 'no-map' | 'unknown';

/** The bounded re-ask schedule while the answer is `not-yet`. */
export const ANCHORED_RETRY_LADDER_MS = [5_000, 15_000, 45_000] as const;

export interface AnchoredTextState {
  /** The last settled answer's kind. Null until a scanned page first asks —
   *  text documents never ask and are never gated. */
  anchoredKind: AnchoredKind | null;
  /** Bumped when a re-ask LANDS the map, so mounted pages re-resolve. The gate
   *  opening onto a page still holding no map would mint exactly the mute
   *  annotation the deferral exists to prevent. */
  anchoredEpoch: number;
  /** Annotate defers on `not-yet` — and ONLY on `not-yet`. The quote is
   *  captured at creation, so an annotation drawn before the map lands is
   *  permanently mute; waiting buys a strictly better annotation. */
  annotateDeferred: boolean;
  /** Request the map, served from a per-resource cache. */
  fetchResourceAnchored: () => Promise<AnchoredText | null>;
}

/**
 * Resolving a resource's anchored text, and keeping at it while the answer is
 * `not-yet`.
 *
 * One concern, previously spread across a cache ref, two pieces of state and
 * three effects in `PdfAnnotationCanvas`: the cached fetch, a bounded retry
 * ladder (the PULL half — self-heals before `smelt:settled` is bridged, and
 * after a missed broadcast once it is), and a `smelt:settled` subscription
 * (the PUSH half — fires at the exact moment `not-yet` stops being true, so
 * the re-ask does not ride out the ladder).
 *
 * The ladder, the gate and the subscription all stand down together: every
 * non-`not-yet` answer is terminal.
 */
export function useAnchoredText(
  session: SemiontSession | null | undefined,
  resourceUri: string,
): AnchoredTextState {
  const resourceAnchoredRef = useRef<{ uri: string; outcome: Promise<AnchoredText | null> } | null>(null);
  const [anchoredKind, setAnchoredKind] = useState<AnchoredKind | null>(null);
  const [anchoredRetryAttempt, setAnchoredRetryAttempt] = useState(0);
  const [anchoredEpoch, setAnchoredEpoch] = useState(0);

  const fetchResourceAnchored = useCallback((): Promise<AnchoredText | null> => {
    if (!session) return Promise.resolve(null); // no session yet — don't cache its absence
    const cached = resourceAnchoredRef.current;
    if (cached && cached.uri === resourceUri) return cached.outcome;

    const uri = resourceUri;
    const entry: { uri: string; outcome: Promise<AnchoredText | null> } = {
      uri,
      outcome: session.client.browse.resourceAnchoredText(toResourceId(uri)).then(
        (served) => {
          // `not-yet` is never pinned: every page load asks again.
          if (served.kind === 'not-yet' && resourceAnchoredRef.current?.uri === uri) {
            resourceAnchoredRef.current = null;
          }
          setAnchoredKind(served.kind);
          return served.kind === 'extracted' ? served : null;
        },
        () => {
          if (resourceAnchoredRef.current?.uri === uri) resourceAnchoredRef.current = null;
          return null;
        },
      ),
    };
    resourceAnchoredRef.current = entry;
    return entry.outcome;
  }, [session, resourceUri]);

  // PULL. The attempt counter is state, not a ref: re-scheduling rides the
  // effect re-running.
  useEffect(() => {
    if (anchoredKind !== 'not-yet') return;
    const delay = ANCHORED_RETRY_LADDER_MS[
      Math.min(anchoredRetryAttempt, ANCHORED_RETRY_LADDER_MS.length - 1)
    ]!;
    const timer = setTimeout(() => {
      void fetchResourceAnchored().then((map) => {
        if (map) setAnchoredEpoch((e) => e + 1);
      });
      setAnchoredRetryAttempt((a) => a + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [anchoredKind, anchoredRetryAttempt, fetchResourceAnchored]);

  useEffect(() => {
    if (anchoredKind !== 'not-yet' && anchoredKind !== null) setAnchoredRetryAttempt(0);
  }, [anchoredKind]);

  // PUSH. Subscribed off the session PROP: the canvas renders provider-free by
  // contract, so the provider-backed subscription hook is off limits here. An
  // `indexed` settle serves the map; a `skipped` one serves the stored decline
  // — either way the re-ask lands a terminal answer.
  useEffect(() => {
    if (!session || anchoredKind !== 'not-yet') return;
    return session.subscribe('smelt:settled', (settled) => {
      if (settled.resourceId !== resourceUri) return;
      if (resourceAnchoredRef.current?.uri === resourceUri) resourceAnchoredRef.current = null;
      void fetchResourceAnchored().then((map) => {
        if (map) setAnchoredEpoch((e) => e + 1);
      });
    });
  }, [session, anchoredKind, resourceUri, fetchResourceAnchored]);

  return {
    anchoredKind,
    anchoredEpoch,
    annotateDeferred: anchoredKind === 'not-yet',
    fetchResourceAnchored,
  };
}
