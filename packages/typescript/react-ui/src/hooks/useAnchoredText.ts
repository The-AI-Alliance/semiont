'use client';

import { useEffect, useState } from 'react';
import { ANCHORED_TEXT_REASK_MS } from '@semiont/core';
import type { AnchoredText, ResourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

/**
 * What a viewer holds of a resource's anchored text.
 *
 * A viewer may annotate only while it holds the text (`held`). The quote of an
 * annotation is cut from the text when the annotation is made and never again,
 * so an annotation made without the text has no quote for good.
 */
export type AnchoredTextState =
  /** It holds the text. The text may be empty: nothing drawn then has a quote. */
  | { status: 'held'; text: AnchoredText }
  /** It holds none yet and is asking: no answer has come, the answer was
   *  `not-yet`, or the ask failed. */
  | { status: 'waiting' }
  /** It holds none and never will: the Smelter declined the document
   *  (`declined`), or there is no such resource (`unknown`). */
  | { status: 'never' }
  /** It holds none and has no session to ask with. */
  | { status: 'unasked' };

const WAITING: AnchoredTextState = { status: 'waiting' };
const NEVER: AnchoredTextState = { status: 'never' };
const UNASKED: AnchoredTextState = { status: 'unasked' };

/** The text of a media type that has none (`no-map`): held, and empty. */
const NO_TEXT: AnchoredTextState = { status: 'held', text: { text: '', items: [] } };

/** An answer that ends the asking, with the ask it answers. */
interface Settled {
  session: SemiontSession;
  resourceUri: ResourceId;
  state: AnchoredTextState;
}

/**
 * Holds a resource's anchored text for a viewer.
 *
 * It asks as soon as there is a session. `extracted` and `no-map` give it the
 * text, and `declined` and `unknown` say there will be none: each ends the
 * asking. After `not-yet`, or an ask that failed, it asks again once
 * `ANCHORED_TEXT_REASK_MS` has passed. The server holds an ask while the
 * Smelter reads the content and answers as soon as it has, so that one wait
 * is all the pacing there is.
 *
 * Another resource, or another session, starts over: what is held is held
 * for the ask that was answered and for no other.
 */
export function useAnchoredText(
  session: SemiontSession | null | undefined,
  resourceUri: ResourceId,
): AnchoredTextState {
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let reask: ReturnType<typeof setTimeout> | undefined;

    const settle = (state: AnchoredTextState) => setSettled({ session, resourceUri, state });
    const ask = () => {
      void session.client.browse.resourceAnchoredText(resourceUri).then(
        (answer) => {
          if (cancelled) return;
          switch (answer.kind) {
            case 'extracted':
              settle({ status: 'held', text: answer });
              return;
            case 'no-map':
              settle(NO_TEXT);
              return;
            case 'declined':
            case 'unknown':
              settle(NEVER);
              return;
            case 'not-yet':
              reask = setTimeout(ask, ANCHORED_TEXT_REASK_MS);
              return;
          }
        },
        () => {
          if (!cancelled) reask = setTimeout(ask, ANCHORED_TEXT_REASK_MS);
        },
      );
    };
    ask();

    return () => {
      cancelled = true;
      clearTimeout(reask);
    };
  }, [session, resourceUri]);

  if (!session) return UNASKED;
  return settled && settled.session === session && settled.resourceUri === resourceUri
    ? settled.state
    : WAITING;
}
