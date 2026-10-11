/**
 * `useAnchoredText` — the retry ladder and the `smelt:settled` push, tested
 * without a PDF.
 *
 * Before this hook existed, the only way to exercise a 45-second retry ladder
 * was to render a whole `PdfAnnotationCanvas`: stub `IntersectionObserver`,
 * stub pdf.js, wait for slots, and then assert on timers threaded through all
 * of it. Here the machine is driven directly, on fake timers, over a REAL
 * `SemiontSession` from `@semiont/sdk/testing`. The one read the hook makes,
 * `browse.resourceAnchoredText`, is answered by a spy on the session's own
 * client: the hook depends on that method's answer, not on what carries it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createTestSession } from '@semiont/sdk/testing';
import { useAnchoredText, ANCHORED_RETRY_LADDER_MS } from '../use-anchored-text';
import { resourceId } from '@semiont/core';
import type { AnchoredTextAnswer } from '@semiont/core';

const RESOURCE = 'res-anchored-1';

const NOT_YET: AnchoredTextAnswer = { kind: 'not-yet' };
const EXTRACTED: AnchoredTextAnswer = { kind: 'extracted', method: 'pdf-text-layer', text: '', items: [] };
const DECLINED: AnchoredTextAnswer = { kind: 'declined', declined: 'no-text-layer' };

/** A session whose anchored-text read answers with `answers`, one per call,
 *  the last repeating — so "not-yet, then extracted" is one array. */
function sessionAnswering(answers: AnchoredTextAnswer[]) {
  const made = createTestSession();
  let call = 0;
  vi.spyOn(made.client.browse, 'resourceAnchoredText').mockImplementation(
    async () => answers[Math.min(call++, answers.length - 1)]!,
  );
  return made;
}

describe('useAnchoredText', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('defers annotate while the answer is `not-yet`, and stands down when the map lands', async () => {
    const { session } = sessionAnswering([NOT_YET, EXTRACTED]);
    const { result } = renderHook(() => useAnchoredText(session, resourceId(RESOURCE)));

    // Nobody has asked yet.
    expect(result.current.anchoredKind).toBeNull();
    expect(result.current.annotateDeferred).toBe(false);

    await act(async () => {
      void result.current.fetchResourceAnchored();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.anchoredKind).toBe('not-yet');
    expect(result.current.annotateDeferred).toBe(true);
    expect(result.current.anchoredEpoch).toBe(0);

    // The first rung of the ladder re-asks, lands `extracted`, and bumps the
    // epoch so mounted pages re-resolve.
    await act(async () => {
      // The rung, then a flush for the re-ask's own reply microtask.
      await vi.advanceTimersByTimeAsync(ANCHORED_RETRY_LADDER_MS[0]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.anchoredKind).toBe('extracted');
    expect(result.current.annotateDeferred).toBe(false);
    expect(result.current.anchoredEpoch).toBe(1);
  });

  it('does not re-ask a terminal answer — `declined` is not `not-yet`', async () => {
    const { session } = sessionAnswering([DECLINED]);
    const { result } = renderHook(() => useAnchoredText(session, resourceId(RESOURCE)));

    await act(async () => {
      void result.current.fetchResourceAnchored();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.anchoredKind).toBe('declined');
    expect(result.current.annotateDeferred).toBe(false);

    // Ride out the whole ladder; a terminal answer must arm no timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        ANCHORED_RETRY_LADDER_MS.reduce((a, b) => a + b, 0) + 1_000,
      );
    });
    expect(result.current.anchoredEpoch).toBe(0);
  });
});
